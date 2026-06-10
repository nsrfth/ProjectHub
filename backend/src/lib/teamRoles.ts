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

async function ensureOneSystemRole(
  teamId: string,
  name: 'Manager' | 'Member',
  preferredId: string,
  perms: readonly string[],
): Promise<string> {
  // Seed + older code paths may have created Manager/Member rows with
  // auto-generated ids. Upsert-by-id then collides on @@unique([teamId,name]).
  const existing = await prisma.role.findUnique({
    where: { teamId_name: { teamId, name } },
  });
  if (existing) {
    await prisma.rolePermission.createMany({
      data: perms.map((permission) => ({ roleId: existing.id, permission })),
      skipDuplicates: true,
    });
    return existing.id;
  }

  await prisma.role.create({
    data: {
      id: preferredId,
      teamId,
      name,
      description: `Default ${name} role. System-managed: editable but undeletable.`,
      isSystem: true,
      permissions: {
        createMany: {
          data: perms.map((permission) => ({ permission })),
          skipDuplicates: true,
        },
      },
    },
  });
  return preferredId;
}

export async function ensureSystemRoles(teamId: string): Promise<SystemRoleIds> {
  const managerId = await ensureOneSystemRole(
    teamId,
    'Manager',
    managerIdFor(teamId),
    DEFAULT_MANAGER_PERMISSIONS,
  );
  const memberId = await ensureOneSystemRole(
    teamId,
    'Member',
    memberIdFor(teamId),
    DEFAULT_MEMBER_PERMISSIONS,
  );
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
