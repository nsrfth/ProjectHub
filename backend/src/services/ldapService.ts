import type { Directory } from '@prisma/client';
import type { ConnectionOptions } from 'node:tls';
import { Client } from 'ldapts';
import { decrypt } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';

// Result of a successful LDAP authentication.
export interface LdapAuthResult {
  // Distinguished name — used as User.externalId.
  dn: string;
  email: string;
  displayName: string;
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

export class LdapService {
  // Search-then-bind authentication. Returns the user's DN + attributes + group
  // DNs on success, or null on bad credentials / not found. Throws on
  // configuration / network errors — those are bugs the admin must fix, not
  // "wrong password" cases.
  async authenticate(
    directory: Directory,
    email: string,
    password: string,
  ): Promise<LdapAuthResult | null> {
    if (!directory.host) throw Errors.badRequest('Directory host missing');
    if (!directory.baseDN) throw Errors.badRequest('Directory baseDN missing');
    if (!directory.bindDN || !directory.bindPasswordEnc) {
      throw Errors.badRequest('Directory bind credentials missing');
    }

    const bindPassword = decrypt(directory.bindPasswordEnc);

    // Step 1: bind as the service account and search for the user.
    let userDn = '';
    let attrs: { email: string; name: string } = { email, name: email };
    await withClient(directory, async (adminClient) => {
      await adminClient.bind(directory.bindDN!, bindPassword);

      const escaped = escapeFilter(email);
      const baseFilter = `(${directory.emailAttr}=${escaped})`;
      const filter = directory.userFilter
        ? `(&${directory.userFilter}${baseFilter})`
        : baseFilter;

      const { searchEntries } = await adminClient.search(directory.baseDN!, {
        scope: 'sub',
        filter,
        attributes: [
          directory.userIdAttr,
          directory.emailAttr,
          directory.nameAttr,
          'dn',
        ],
        sizeLimit: 2,
      });

      if (searchEntries.length === 0) return;
      if (searchEntries.length > 1) {
        throw Errors.internal(
          `Ambiguous LDAP search: multiple entries for ${email}. Check userFilter.`,
        );
      }
      const entry = searchEntries[0]!;
      userDn = entry.dn;
      attrs = {
        email: String(entry[directory.emailAttr] ?? email),
        name: String(entry[directory.nameAttr] ?? email),
      };
    });

    if (!userDn) return null;

    // Step 2: rebind as the user with the supplied password.
    try {
      await withClient(directory, async (userClient) => {
        await userClient.bind(userDn, password);
      });
    } catch {
      return null;
    }

    const groups = await this.fetchGroups(directory, userDn).catch(() => [] as string[]);

    return {
      dn: userDn,
      email: attrs.email,
      displayName: attrs.name,
      groups,
    };
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
