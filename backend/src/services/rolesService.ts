import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { isValidPermission, type Permission } from '../lib/permissions.js';

// v1.23: per-team custom roles. CRUD + permission assignment. The route
// layer gates everything on requirePermission('team.manage_roles'); this
// service additionally enforces:
//   - role name unique per team (DB unique index does the heavy lift)
//   - system roles are editable but undeletable
//   - permissions on write are validated against the code constants
//   - a role currently assigned to any TeamMembership can't be deleted

export interface RoleView {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Permission[];
  membershipCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type RoleRow = Prisma.RoleGetPayload<{
  include: {
    permissions: { select: { permission: true } };
    _count: { select: { memberships: true } };
  };
}>;

function toView(row: RoleRow): RoleView {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    permissions: row.permissions
      .map((p) => p.permission)
      .filter(isValidPermission)
      // Stable order so the UI doesn't shuffle on every render.
      .sort(),
    membershipCount: row._count.memberships,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Reject any string that isn't a known permission constant. Returns the
// deduplicated, valid subset; throws if any input is unknown.
function validatePermissions(perms: readonly string[]): Permission[] {
  const seen = new Set<Permission>();
  for (const p of perms) {
    if (!isValidPermission(p)) {
      throw Errors.badRequest(`Unknown permission: ${p}`);
    }
    seen.add(p);
  }
  return [...seen];
}

const ROLE_INCLUDE = {
  permissions: { select: { permission: true } },
  _count: { select: { memberships: true } },
} as const;

export class RolesService {
  async list(teamId: string): Promise<RoleView[]> {
    const rows = await prisma.role.findMany({
      where: { teamId },
      include: ROLE_INCLUDE,
      // System roles first, then custom roles alphabetically — matches the
      // UI's likely sort.
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toView);
  }

  async get(teamId: string, roleId: string): Promise<RoleView> {
    const row = await prisma.role.findUnique({
      where: { id: roleId },
      include: ROLE_INCLUDE,
    });
    if (!row || row.teamId !== teamId) throw Errors.notFound('Role not found');
    return toView(row);
  }

  async create(
    teamId: string,
    input: { name: string; description?: string | null; permissions: string[] },
  ): Promise<RoleView> {
    const perms = validatePermissions(input.permissions);
    try {
      const row = await prisma.role.create({
        data: {
          teamId,
          name: input.name,
          description: input.description ?? null,
          isSystem: false,
          permissions: {
            create: perms.map((permission) => ({ permission })),
          },
        },
        include: ROLE_INCLUDE,
      });
      return toView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A role with this name already exists in this team');
      }
      throw err;
    }
  }

  async update(
    teamId: string,
    roleId: string,
    input: { name?: string; description?: string | null },
  ): Promise<RoleView> {
    const existing = await this.get(teamId, roleId);
    // System roles can be edited (description + permissions) but renaming
    // them would break the migration's lookup by name. Block name changes.
    if (existing.isSystem && input.name !== undefined && input.name !== existing.name) {
      throw Errors.badRequest('System role names cannot be changed');
    }
    try {
      const row = await prisma.role.update({
        where: { id: roleId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
        },
        include: ROLE_INCLUDE,
      });
      return toView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A role with this name already exists in this team');
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Role not found');
      }
      throw err;
    }
  }

  // Idempotent full-replacement of the permission set. PUT semantics so the
  // matrix UI can just send the current checkbox state and not worry about
  // add/remove deltas.
  async setPermissions(
    teamId: string,
    roleId: string,
    permissions: readonly string[],
  ): Promise<RoleView> {
    await this.get(teamId, roleId); // 404 if not in this team
    const perms = validatePermissions(permissions);

    // Replace inside a transaction so a half-update can't leave the role in
    // an inconsistent state. DELETE all then INSERT — simpler than computing
    // the diff and fast enough at 15 permissions per role.
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId } }),
      prisma.rolePermission.createMany({
        data: perms.map((permission) => ({ roleId, permission })),
        skipDuplicates: true,
      }),
    ]);
    return this.get(teamId, roleId);
  }

  async remove(teamId: string, roleId: string): Promise<void> {
    const existing = await this.get(teamId, roleId);
    if (existing.isSystem) {
      throw Errors.badRequest('System roles cannot be deleted');
    }
    if (existing.membershipCount > 0) {
      throw Errors.conflict(
        `Role is assigned to ${existing.membershipCount} member(s). Reassign them before deleting.`,
      );
    }
    await prisma.role.delete({ where: { id: roleId } });
  }
}
