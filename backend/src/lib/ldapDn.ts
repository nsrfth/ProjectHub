// Case-insensitive LDAP DN helpers. Active Directory returns DNs with
// varying attribute-type casing (CN= vs cn=) and admins often paste
// mappings in a different case than AD stores on memberOf.

export function normalizeLdapDn(dn: string): string {
  return dn.trim().replace(/\s+/g, '').toLowerCase();
}

export function groupDnsMatch(userGroups: string[], mappingDn: string): boolean {
  const target = normalizeLdapDn(mappingDn);
  return userGroups.some((g) => normalizeLdapDn(g) === target);
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
