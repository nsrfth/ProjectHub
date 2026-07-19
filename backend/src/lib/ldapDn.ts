// Case-insensitive LDAP DN helpers. Active Directory returns DNs with
// varying attribute-type casing (CN= vs cn=) and admins often paste
// mappings in a different case than AD stores on memberOf.

/**
 * Normalise a DN for case-insensitive comparison.
 *
 * v2.6 (Phase 0a): this used to be `dn.trim().replace(/\s+/g, '').toLowerCase()`,
 * which stripped ALL whitespace — including whitespace *inside* attribute
 * values, not just the optional spaces around RDN separators. That collapsed
 * genuinely distinct groups onto the same key:
 *
 *   CN=Ops Team,OU=Groups,DC=example,DC=com  ->  cn=opsteam,ou=groups,...
 *   CN=OpsTeam,OU=Groups,DC=example,DC=com   ->  cn=opsteam,ou=groups,...
 *
 * `groupDnsMatch` would then match a member of either group against a mapping
 * for the other, granting membership in the wrong team. At login that affects
 * one user at a time; the scheduled directory sync applies it to every account
 * in the directory, so it is fixed before that job ships.
 *
 * Now only the separators are normalised and intra-value whitespace survives.
 *
 * Two deliberate details:
 *
 *  - The `=` replace is NOT global. Only the first `=` in an RDN separates the
 *    attribute type from its value; a later one belongs to the value and must
 *    be preserved verbatim.
 *  - Splitting on `,` does not honour RFC 4514 escaping, so a DN with an
 *    escaped comma inside a value (`CN=Smith\, John,OU=x`) is still split into
 *    bogus RDNs. That is pre-existing and out of scope for this fix — but it is
 *    now *detected*: `hasEscapedComma` below lets callers refuse rather than
 *    guess, and the Phase 0d coverage report flags any mapping containing one.
 */
export function normalizeLdapDn(dn: string): string {
  return dn
    .trim()
    .split(',')
    .map((rdn) => rdn.trim().replace(/\s*=\s*/, '='))
    .join(',')
    .toLowerCase();
}

/** True when any of `userGroups` is the same DN as `mappingDn`. */
export function groupDnsMatch(userGroups: string[], mappingDn: string): boolean {
  const target = normalizeLdapDn(mappingDn);
  return userGroups.some((g) => normalizeLdapDn(g) === target);
}

/**
 * True when a DN contains an RFC 4514 escaped comma, which neither this module
 * nor any caller parses correctly. Callers that must not silently mis-compare
 * (the directory sync job, the coverage report) use this to refuse or warn
 * rather than guess.
 */
export function hasEscapedComma(dn: string): boolean {
  return /\\,/.test(dn);
}

/** Merge memberOf (from the user entry) with group-search results, deduped. */
export function mergeGroupDns(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dn of list) {
      const key = normalizeLdapDn(dn);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(dn);
      }
    }
  }
  return out;
}
