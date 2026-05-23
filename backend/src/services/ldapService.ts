import type { Directory } from '@prisma/client';
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

function buildUrl(d: Directory): string {
  if (!d.host) throw Errors.badRequest('Directory has no host configured');
  const port = d.port ?? (d.useTLS ? 636 : 389);
  const scheme = d.useTLS ? 'ldaps' : 'ldap';
  return `${scheme}://${d.host}:${port}`;
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
    const url = buildUrl(directory);

    // Step 1: bind as the service account and search for the user.
    const adminClient = new Client({ url, timeout: 5000, connectTimeout: 5000 });
    let userDn: string;
    let attrs: { email: string; name: string };
    try {
      await adminClient.bind(directory.bindDN, bindPassword);

      const escaped = escapeFilter(email);
      const baseFilter = `(${directory.emailAttr}=${escaped})`;
      const filter = directory.userFilter
        ? `(&${directory.userFilter}${baseFilter})`
        : baseFilter;

      const { searchEntries } = await adminClient.search(directory.baseDN, {
        scope: 'sub',
        filter,
        attributes: [
          directory.userIdAttr,
          directory.emailAttr,
          directory.nameAttr,
          'dn',
        ],
        sizeLimit: 2, // We only ever expect one match; two means misconfig.
      });

      if (searchEntries.length === 0) return null;
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
    } finally {
      await adminClient.unbind().catch(() => undefined);
    }

    // Step 2: rebind as the user with the supplied password. This is the
    // actual credential check — a successful search proves the user exists,
    // not that they typed the right password.
    const userClient = new Client({ url, timeout: 5000, connectTimeout: 5000 });
    try {
      await userClient.bind(userDn, password);
    } catch {
      // Invalid credentials — return null. Don't leak the specific reason
      // (account locked, password expired) so we keep the "invalid
      // credentials" response symmetric with the local-password path.
      await userClient.unbind().catch(() => undefined);
      return null;
    }
    await userClient.unbind().catch(() => undefined);

    // Step 3: enumerate groups the user belongs to. Best-effort: a failure
    // here doesn't block login, it just leaves `groups: []`.
    const groups = await this.fetchGroups(directory, userDn).catch(() => [] as string[]);

    return {
      dn: userDn,
      email: attrs.email,
      displayName: attrs.name,
      groups,
    };
  }

  // Look up which groups contain the given user DN as a member. Re-uses the
  // service-account bind. Filter is `(<groupMemberAttr>=<dn>)`, optionally
  // ANDed with the directory's groupFilter.
  async fetchGroups(directory: Directory, userDn: string): Promise<string[]> {
    if (!directory.host || !directory.baseDN || !directory.bindDN || !directory.bindPasswordEnc) {
      return [];
    }
    const bindPassword = decrypt(directory.bindPasswordEnc);
    const url = buildUrl(directory);
    const client = new Client({ url, timeout: 5000, connectTimeout: 5000 });
    try {
      await client.bind(directory.bindDN, bindPassword);
      const memberFilter = `(${directory.groupMemberAttr}=${escapeFilter(userDn)})`;
      const filter = directory.groupFilter
        ? `(&${directory.groupFilter}${memberFilter})`
        : memberFilter;
      const { searchEntries } = await client.search(directory.baseDN, {
        scope: 'sub',
        filter,
        attributes: ['dn'],
      });
      return searchEntries.map((e) => e.dn);
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  // Connection test — used by the directory CRUD UI to validate config
  // without persisting. Returns a tuple { ok, sampleUserCount } or { ok:false, message }.
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

    const client = new Client({ url: buildUrl(directory), timeout: 5000, connectTimeout: 5000 });
    try {
      await client.bind(directory.bindDN, bindPassword);
      const filter = directory.userFilter ?? `(${directory.userIdAttr}=*)`;
      const { searchEntries } = await client.search(directory.baseDN, {
        scope: 'sub',
        filter,
        attributes: [directory.userIdAttr],
        sizeLimit: 5,
      });
      return { ok: true, sampleUserCount: searchEntries.length };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}
