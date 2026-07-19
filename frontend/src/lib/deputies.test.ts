import { describe, expect, it } from 'vitest';
import { departmentManager, deriveDeputies, systemRoleId, tierRoles } from './deputies';

const roles = [
  { id: 'r_mgr', name: 'Manager', isSystem: true },
  { id: 'r_mem', name: 'Member', isSystem: true },
  { id: 'r_custom', name: 'Manager', isSystem: false }, // custom role named Manager!
];
const members = [
  { userId: 'u1', name: 'Naser', roleId: 'r_mgr', external: false },
  { userId: 'u2', name: 'Sara', roleId: 'r_mem', external: false },
  { userId: 'u3', name: 'Impostor', roleId: 'r_custom', external: false },
  { userId: 'u4', name: 'Guest', roleId: 'r_mgr', external: true },
];

describe('deriveDeputies (v2.11)', () => {
  it('deputy = SYSTEM Manager role holder, nothing wider', () => {
    expect(deriveDeputies(members, roles).map((m) => m.userId)).toEqual(['u1']);
  });
  it('a custom role coincidentally named Manager does not qualify', () => {
    expect(deriveDeputies(members, roles).some((m) => m.userId === 'u3')).toBe(false);
  });
  it('external accessors never qualify', () => {
    expect(deriveDeputies(members, roles).some((m) => m.userId === 'u4')).toBe(false);
  });
  it('no system Manager role -> no deputies (never guesses)', () => {
    expect(deriveDeputies(members, [{ id: 'x', name: 'Chief', isSystem: true }])).toEqual([]);
    expect(systemRoleId(roles, 'manager')).toBe('r_mgr');
  });
});

describe('departmentManager (v2.13 create-project autofill)', () => {
  const roster = [
    { userId: 'u1', unitId: 'net', unitRole: 'MANAGER' as const },
    { userId: 'u2', unitId: 'net', unitRole: 'MEMBER' as const },
    { userId: 'u3', unitId: null, unitRole: null },
  ];
  it('finds the unit manager for the chosen department', () => {
    expect(departmentManager(roster, 'net')?.userId).toBe('u1');
  });
  it('returns null when the department has no manager', () => {
    expect(departmentManager(roster, 'sec')).toBeNull();
  });
});

describe('tierRoles (v2.14 department tier picker)', () => {
  it('resolves post-rename FA names and pre-rename EN fallbacks', () => {
    const fa = tierRoles([
      { id: 'a', name: 'سرپرست', isSystem: false },
      { id: 'b', name: 'کارشناس', isSystem: false },
    ]);
    expect(fa).toEqual({ supervisorId: 'a', specialistId: 'b' });
    const en = tierRoles([
      { id: 'c', name: 'Supervisor', isSystem: false },
      { id: 'd', name: 'Expert', isSystem: false },
    ]);
    expect(en).toEqual({ supervisorId: 'c', specialistId: 'd' });
  });
  it('never offers system roles, even name-matching ones', () => {
    expect(
      tierRoles([{ id: 'x', name: 'Supervisor', isSystem: true }]).supervisorId,
    ).toBeNull();
  });
});
