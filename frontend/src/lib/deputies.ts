// v2.11: derive a division's deputies (معاون) — the members holding its
// SYSTEM Manager role. Pure so the rule is testable without a DOM: the deputy
// concept is "system Manager role holder", nothing else, and the UI must not
// silently widen it (e.g. to legacy-enum managers, which the 1B backfill
// eliminated).
export interface DeputyMemberLike {
  userId: string;
  name: string;
  roleId: string | null;
  external: boolean;
}
export interface DeputyRoleLike {
  id: string;
  name: string;
  isSystem: boolean;
}

export function systemRoleId(roles: DeputyRoleLike[], name: string): string | null {
  return roles.find((r) => r.isSystem && r.name.trim().toLowerCase() === name)?.id ?? null;
}

export function deriveDeputies<M extends DeputyMemberLike>(
  members: M[],
  roles: DeputyRoleLike[],
): M[] {
  const managerId = systemRoleId(roles, 'manager');
  if (!managerId) return [];
  return members.filter((m) => !m.external && m.roleId === managerId);
}

// v2.13: the member running a given department (unitRole MANAGER on that
// unit), for the create-project autofill (accountable = مدیرکل).
export interface UnitMemberLike {
  userId: string;
  unitId: string | null;
  unitRole: 'MANAGER' | 'MEMBER' | null;
}
export function departmentManager<M extends UnitMemberLike>(
  members: M[],
  unitId: string,
): M | null {
  return members.find((m) => m.unitId === unitId && m.unitRole === 'MANAGER') ?? null;
}
