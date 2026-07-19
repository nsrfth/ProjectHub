// v2.10 (nomenclature wave, Q2): system roles keep their DB names — scripts
// and Phase 6 gates match on them — but DISPLAY under the organizational
// vocabulary: system "Manager" renders as «معاون» / Deputy.
//
// The mapping applies ONLY to isSystem roles. Custom roles (including the
// seeded-but-editable tiers) are data owned by each division's admins; a
// display map over those would silently fight their edits.

export interface RoleLike {
  name: string;
  isSystem: boolean;
}

/** i18n keys per known system-role name (lowercased). */
const SYSTEM_ROLE_KEYS: Record<string, string> = {
  manager: 'roles.system.manager',
  member: 'roles.system.member',
  pmo: 'roles.system.pmo',
};

export function displayRoleName(role: RoleLike, t: (key: string) => string): string {
  if (!role.isSystem) return role.name;
  const key = SYSTEM_ROLE_KEYS[role.name.trim().toLowerCase()];
  if (!key) return role.name;
  const label = t(key);
  // A missing i18n key returns the key itself in this app's t(); fall back to
  // the stored name rather than showing "roles.system.manager" to a human.
  return label === key ? role.name : label;
}

// v2.10: context-dependent GroupRole badge (role-label matrix). In a UNIT the
// MANAGER is the department director («مدیرکل»); in a COLLAB group they are a
// group manager («مدیر گروه»).
export function groupRoleLabelKey(kind: 'UNIT' | 'COLLAB', role: 'MANAGER' | 'MEMBER'): string {
  if (role === 'MEMBER') return kind === 'UNIT' ? 'units.memberRole.member' : 'groups.memberRole.member';
  return kind === 'UNIT' ? 'units.memberRole.manager' : 'groups.memberRole.manager';
}
