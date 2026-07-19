import { describe, expect, it } from 'vitest';
import { deriveDeputies, systemRoleId } from './deputies';

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
