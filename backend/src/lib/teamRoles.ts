import type { TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import {
  DEFAULT_MANAGER_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
} from './permissions.js';

// v1.30.6 (S-6 / S-7): every TeamMembership must carry a `roleId` that
// points at a real Role row. The v1.23 migration backfilled this for
// every team that existed at migration time, but:
//
//   - SCIM-created teams (post-v1.23) get created without system roles
//     because the SCIM service didn't know about v1.23.
//   - LDAP JIT provisioning historically created memberships with
//     `roleId: null`, falling back to the legacy enum + the hardcoded
//     `DEFAULT_*_PERMISSIONS` constants instead of the team's own
//     (potentially-edited) Manager / Member rows.
//
// `ensureSystemRoles` is idempotent — call it before any code path that
// needs to set `roleId` on a directory-managed membership. It uses the
// same `mgr_${teamId}` / `mem_${teamId}` id convention as the v1.23
// migration so backfilled rows and freshly-created ones look identical.

export interface SystemRoleIds {
  managerId: string;
  memberId: string;
}

function managerIdFor(teamId: string): string {
  return `mgr_${teamId}`;
}

function memberIdFor(teamId: string): string {
  return `mem_${teamId}`;
}

export async function ensureSystemRoles(teamId: string): Promise<SystemRoleIds> {
  const managerId = managerIdFor(teamId);
  const memberId = memberIdFor(teamId);

  // The system Manager role.
  await prisma.role.upsert({
    where: { id: managerId },
    update: {},
    create: {
      id: managerId,
      teamId,
      name: 'Manager',
      description: 'Default Manager role. System-managed: editable but undeletable.',
      isSystem: true,
      permissions: {
        // createMany with skipDuplicates is idempotent on retries.
        createMany: {
          data: DEFAULT_MANAGER_PERMISSIONS.map((p) => ({ permission: p })),
          skipDuplicates: true,
        },
      },
    },
  });

  // The system Member role.
  await prisma.role.upsert({
    where: { id: memberId },
    update: {},
    create: {
      id: memberId,
      teamId,
      name: 'Member',
      description: 'Default Member role. System-managed: editable but undeletable.',
      isSystem: true,
      permissions: {
        createMany: {
          data: DEFAULT_MEMBER_PERMISSIONS.map((p) => ({ permission: p })),
          skipDuplicates: true,
        },
      },
    },
  });

  return { managerId, memberId };
}

// Map a legacy TeamRole enum value onto the team's system-role id.
// Used by both the LDAP and SCIM paths when a DirectoryGroupMapping
// doesn't carry an explicit custom roleId.
export async function systemRoleIdFor(
  teamId: string,
  teamRole: TeamRole,
): Promise<string> {
  const { managerId, memberId } = await ensureSystemRoles(teamId);
  return teamRole === 'MANAGER' ? managerId : memberId;
}
