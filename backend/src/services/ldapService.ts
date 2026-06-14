import type { Directory } from '@prisma/client';
import type { ConnectionOptions } from 'node:tls';
import { Client } from 'ldapts';
import { decrypt } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import { mergeGroupDns } from '../lib/ldapDn.js';

// Result of a successful LDAP authentication or profile lookup.
export interface LdapAuthResult {
  // Distinguished name — used as User.externalId.
  dn: string;
  email: string;
  displayName: string;
  ldapUsername: string | null;
  userPrincipalName: string | null;
  department: string | null;
  jobTitle: string | null;
  managerName: string | null;
  // DNs of groups the user belongs to. Empty if no group lookup happened.
  groups: string[];
}

// RFC 4515 escaping. User-supplied values interpolated into a filter MUST
// escape `\`, `*`, `(`, `)`, NUL. Without this, an attacker types
// `*)(uid=*` into the email field and gets the first user back.
export function escapeFilter(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x5c: out += String.raw`\5c`; break;
      case 0x2a: out += String.raw`\2a`; break;
      case 0x28: out += String.raw`\28`; break;
      case 0x29: out += String.raw`\29`; break;
      case 0x00: out += String.raw`\00`; break;
      default:   out += value[i];
    }
  }
  return out;
}

export type LdapTransport = 'plain' | 'starttls' | 'ldaps';

// Strip accidental ldap:// / ldaps:// prefixes from the host field.
export function normaliseLdapHost(host: string): string {
  return host.trim().replace(/^ldaps?:\/\//i, '').replace(/\/$/, '');
}

// Resolve how we connect:
//   plain    — ldap://host:389, no encryption (OpenLDAP dev; AD rejects)
//   starttls — ldap://host:389 then TLS upgrade (typical AD on port 389)
//   ldaps    — ldaps://host:636 implicit TLS
export function resolveLdapTransport(directory: Pick<Directory, 'useTLS' | 'port'>): LdapTransport {
  if (!directory.useTLS) return 'plain';
  const port = directory.port ?? 636;
  return port === 389 ? 'starttls' : 'ldaps';
}

function buildUrl(directory: Directory, transport: LdapTransport): string {
  if (!directory.host) throw Errors.badRequest('Directory has no host configured');
  const host = normaliseLdapHost(directory.host);
  const port = directory.port ?? (transport === 'ldaps' ? 636 : 389);
  const scheme = transport === 'ldaps' ? 'ldaps' : 'ldap';
  return `${scheme}://${host}:${port}`;
}

function tlsOptions(directory: Directory): ConnectionOptions | undefined {
  const insecure =
    directory.tlsInsecure || process.env.LDAP_TLS_INSECURE === 'true';
  if (!insecure) return undefined;
  return { rejectUnauthorized: false };
}

async function openClient(directory: Directory): Promise<Client> {
  const transport = resolveLdapTransport(directory);
  const url = buildUrl(directory, transport);
  const tls = tlsOptions(directory);
  const client = new Client({
    url,
    timeout: 5000,
    connectTimeout: 5000,
    ...(transport === 'ldaps' && tls ? { tlsOptions: tls } : {}),
  });
  if (transport === 'starttls') {
    await client.startTLS(tls ?? {});
  }
  return client;
}

async function withClient<T>(
  directory: Directory,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await openClient(directory);
  try {
    return await fn(client);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

function entryAttr(entry: Record<string, unknown>, name: string): string | null {
  const v = entry[name];
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return String(v);
}

function userSearchFilter(directory: Directory, identifier: string): string {
  const escaped = escapeFilter(identifier);
  const byEmail = `(${directory.emailAttr}=${escaped})`;
  const byUserId = `(${directory.userIdAttr}=${escaped})`;
  const byUpn = '(userPrincipalName=' + escaped + ')';
  const match = directory.userIdAttr === 'userPrincipalName'
    ? `(|${byEmail}${byUserId})`
    : `(|${byEmail}${byUserId}${byUpn})`;
  return directory.userFilter ? `(&${directory.userFilter}${match})` : match;
}

const PROFILE_ATTRS = (directory: Directory) => [
  directory.userIdAttr,
  directory.emailAttr,
  directory.nameAttr,
  'userPrincipalName',
  'department',
  'title',
  'manager',
  'memberOf',
  'dn',
];

function entryAttrMulti(entry: Record<string, unknown>, name: string): string[] {
  const v = entry[name];
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

function profileFromEntry(
  directory: Directory,
  entry: Record<string, unknown>,
  fallbackIdentifier: string,
  managerName: string | null,
): Omit<LdapAuthResult, 'groups'> {
  return {
    dn: String(entry.dn),
    email: entryAttr(entry, directory.emailAttr) ?? fallbackIdentifier,
    displayName: entryAttr(entry, directory.nameAttr) ?? fallbackIdentifier,
    ldapUsername: entryAttr(entry, directory.userIdAttr),
    userPrincipalName: entryAttr(entry, 'userPrincipalName'),
    department: entryAttr(entry, 'department'),
    jobTitle: entryAttr(entry, 'title'),
    managerName,
  };
}

export class LdapService {
  // Search-then-bind authentication. Returns the user's DN + attributes + group
  // DNs on success, or null on bad credentials / not found. Throws on
  // configuration / network errors — those are bugs the admin must fix, not
  // "wrong password" cases.
  async authenticate(
    directory: Directory,
    identifier: string,
    password: string,
  ): Promise<LdapAuthResult | null> {
    if (!directory.host) throw Errors.badRequest('Directory host missing');
    if (!directory.baseDN) throw Errors.badRequest('Directory baseDN missing');
    if (!directory.bindDN || !directory.bindPasswordEnc) {
      throw Errors.badRequest('Directory bind credentials missing');
    }

    const bindPassword = decrypt(directory.bindPasswordEnc);
    const resolvedProfile = await this.searchUserProfile(directory, identifier, bindPassword);
    if (!resolvedProfile) return null;

    // Step 2: rebind as the user with the supplied password.
    try {
      await withClient(directory, async (userClient) => {
        await userClient.bind(resolvedProfile.dn, password);
      });
    } catch {
      return null;
    }

    const memberOf = resolvedProfile.memberOf;
    const searched = await this.fetchGroups(directory, resolvedProfile.dn).catch(() => [] as string[]);
    return { ...resolvedProfile, groups: mergeGroupDns(memberOf, searched) };
  }

  private async searchUserProfile(
    directory: Directory,
    identifier: string,
    bindPassword: string,
  ): Promise<(Omit<LdapAuthResult, 'groups'> & { memberOf: string[] }) | null> {
    return withClient(directory, async (adminClient) => {
      await adminClient.bind(directory.bindDN!, bindPassword);

      const filter = userSearchFilter(directory, identifier);
      const { searchEntries } = await adminClient.search(directory.baseDN!, {
        scope: 'sub',
        filter,
        attributes: PROFILE_ATTRS(directory),
        sizeLimit: 2,
      });

      if (searchEntries.length === 0) return null;
      if (searchEntries.length > 1) {
        throw Errors.internal(
          `Ambiguous LDAP search: multiple entries for ${identifier}. Check userFilter.`,
        );
      }
      const entry = searchEntries[0]! as Record<string, unknown>;
      const managerDn = entryAttr(entry, 'manager');
      const managerName = managerDn
        ? await this.resolveManagerName(adminClient, managerDn)
        : null;
      return {
        ...profileFromEntry(directory, entry, identifier, managerName),
        memberOf: entryAttrMulti(entry, 'memberOf'),
      };
    });
  }

  // Service-account profile refresh — no password bind. Used by admin sync.
  async fetchUserProfile(directory: Directory, userDn: string): Promise<LdapAuthResult | null> {
    if (!directory.host || !directory.baseDN || !directory.bindDN || !directory.bindPasswordEnc) {
      throw Errors.badRequest('Directory LDAP connection is not fully configured');
    }
    const bindPassword = decrypt(directory.bindPasswordEnc);

    return withClient(directory, async (client) => {
      await client.bind(directory.bindDN!, bindPassword);
      const { searchEntries } = await client.search(userDn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: PROFILE_ATTRS(directory),
      });
      if (!searchEntries.length) return null;
      const entry = searchEntries[0]! as Record<string, unknown>;
      const managerDn = entryAttr(entry, 'manager');
      const managerName = managerDn
        ? await this.resolveManagerName(client, managerDn)
        : null;
      const profile = profileFromEntry(directory, entry, userDn, managerName);
      const memberOf = entryAttrMulti(entry, 'memberOf');
      const searched = await this.fetchGroups(directory, userDn).catch(() => [] as string[]);
      return { ...profile, groups: mergeGroupDns(memberOf, searched) };
    });
  }

  private async resolveManagerName(client: Client, managerDn: string): Promise<string | null> {
    try {
      const { searchEntries } = await client.search(managerDn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['cn', 'displayName'],
      });
      if (!searchEntries.length) return null;
      const entry = searchEntries[0]! as Record<string, unknown>;
      return entryAttr(entry, 'displayName') ?? entryAttr(entry, 'cn');
    } catch {
      return null;
    }
  }

  async fetchGroups(directory: Directory, userDn: string): Promise<string[]> {
    if (!directory.host || !directory.baseDN || !directory.bindDN || !directory.bindPasswordEnc) {
      return [];
    }
    const bindPassword = decrypt(directory.bindPasswordEnc);
    return withClient(directory, async (client) => {
      await client.bind(directory.bindDN!, bindPassword);
      const memberFilter = `(${directory.groupMemberAttr}=${escapeFilter(userDn)})`;
      const filter = directory.groupFilter
        ? `(&${directory.groupFilter}${memberFilter})`
        : memberFilter;
      const { searchEntries } = await client.search(directory.baseDN!, {
        scope: 'sub',
        filter,
        attributes: ['dn'],
      });
      return searchEntries.map((e) => e.dn);
    });
  }

  async testConnection(
    directory: Directory,
    plaintextPasswordOverride?: string,
  ): Promise<{ ok: true; sampleUserCount: number } | { ok: false; message: string }> {
    if (!directory.host || !directory.baseDN || !directory.bindDN) {
      return { ok: false, message: 'host, baseDN, and bindDN are required' };
    }
    const bindPassword = plaintextPasswordOverride
      ?? (directory.bindPasswordEnc ? decrypt(directory.bindPasswordEnc) : null);
    if (!bindPassword) return { ok: false, message: 'bindPassword not configured' };

    try {
      return await withClient(directory, async (client) => {
        await client.bind(directory.bindDN!, bindPassword);
        const filter = directory.userFilter ?? `(${directory.userIdAttr}=*)`;
        const { searchEntries } = await client.search(directory.baseDN!, {
          scope: 'sub',
          filter,
          attributes: [directory.userIdAttr],
          sizeLimit: 5,
        });
        return { ok: true, sampleUserCount: searchEntries.length };
      });
    } catch (e) {
      const message = (e as Error).message;
      if (
        !directory.useTLS
        && message.includes('integrity checking')
      ) {
        return {
          ok: false,
          message:
            `${message} — Active Directory requires an encrypted connection. `
            + 'Enable "Encrypt connection", keep port 389 (STARTTLS), and if needed '
            + 'enable "Skip TLS certificate verification".',
        };
      }
      return { ok: false, message };
    }
  }
}

// True when the error looks like a directory connectivity / TLS failure
// rather than bad credentials.
export function isLdapInfrastructureError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnrefused')
    || msg.includes('econnreset')
    || msg.includes('etimedout')
    || msg.includes('enotfound')
    || msg.includes('getaddrinfo')
    || msg.includes('certificate')
    || msg.includes('tls')
    || msg.includes('socket')
    || msg.includes('timeout')
  );
}
