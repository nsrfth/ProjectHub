import { describe, expect, it } from 'vitest';
import { displayRoleName, groupRoleLabelKey } from './displayRoleName';

const t = (key: string): string =>
  ({
    'roles.system.manager': 'معاون',
    'roles.system.member': 'عضو',
  })[key] ?? key;

describe('displayRoleName (v2.10 Q2)', () => {
  it('maps the system Manager role to معاون/Deputy', () => {
    expect(displayRoleName({ name: 'Manager', isSystem: true }, t)).toBe('معاون');
    // Case-insensitive, matching the backend lookups.
    expect(displayRoleName({ name: 'manager', isSystem: true }, t)).toBe('معاون');
  });

  it('leaves custom role names verbatim — even ones named like system roles', () => {
    expect(displayRoleName({ name: 'Manager', isSystem: false }, t)).toBe('Manager');
    expect(displayRoleName({ name: 'سرپرست', isSystem: false }, t)).toBe('سرپرست');
    expect(displayRoleName({ name: 'Supervisor', isSystem: false }, t)).toBe('Supervisor');
  });

  it('falls back to the stored name for unknown system roles and missing i18n keys', () => {
    expect(displayRoleName({ name: 'Auditor', isSystem: true }, t)).toBe('Auditor');
    // PMO is a known system name but the stub t() has no key → stored name.
    expect(displayRoleName({ name: 'PMO', isSystem: true }, t)).toBe('PMO');
  });
});

describe('groupRoleLabelKey (role-label matrix)', () => {
  it('UNIT manager is the director; COLLAB manager is a group manager', () => {
    expect(groupRoleLabelKey('UNIT', 'MANAGER')).toBe('units.memberRole.manager');
    expect(groupRoleLabelKey('COLLAB', 'MANAGER')).toBe('groups.memberRole.manager');
    expect(groupRoleLabelKey('UNIT', 'MEMBER')).toBe('units.memberRole.member');
    expect(groupRoleLabelKey('COLLAB', 'MEMBER')).toBe('groups.memberRole.member');
  });
});
