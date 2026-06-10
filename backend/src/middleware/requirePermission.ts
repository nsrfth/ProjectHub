import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { GlobalRole, TeamMembership } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import type { Permission } from '../lib/permissions.js';
import { DEFAULT_MANAGER_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS } from '../lib/permissions.js';
import {
  getSystemUserId,
  isSystemUserId,
  resolveTeamMembership,
  systemUserHasManagerPermission,
} from '../lib/systemUser.js';

// v1.23: per-permission RBAC. The route layer already runs requireTeamRole
// upstream to validate team membership + stash the membership on the request;
// this middleware then checks for a specific permission.
//
// Lookup order:
//   1. Global ADMIN bypass — always allowed (lockout-proof escape hatch)
//   2. Custom role permissions via TeamMembership.roleId → RolePermission
//   3. Fallback to the legacy TeamMembership.role enum mapped to the
//      DEFAULT_*_PERMISSIONS sets — kicks in only when roleId is NULL
//      (mid-migration row that wasn't backfilled, or a directly-inserted
//      row from an older code path)

export async function hasPermission(
  request: FastifyRequest,
  permission: Permission,
): Promise<boolean> {
  if (!request.user) return false;
  if (request.user.globalRole === 'ADMIN') return true;

  const m = (request as { membership?: TeamMembership }).membership;
  if (!m) return false;

  if (m.roleId) {
    const row = await prisma.rolePermission.findUnique({
      where: { roleId_permission: { roleId: m.roleId, permission } },
      select: { roleId: true },
    });
    return !!row;
  }

  // Legacy fallback for rows the v1.23 migration didn't backfill.
  const defaults =
    m.role === 'MANAGER' ? DEFAULT_MANAGER_PERMISSIONS : DEFAULT_MEMBER_PERMISSIONS;
  return (defaults as readonly string[]).includes(permission);
}

// Cheap per-membership permission lookup used by the matrix renderer + by
// hot paths that check several permissions for the same caller. Skip the
// per-permission round-trip by reading the whole set once.
export async function listMembershipPermissions(
  m: TeamMembership,
  globalRole: 'ADMIN' | 'MEMBER',
): Promise<Set<string>> {
  if (globalRole === 'ADMIN') {
    // Admins implicitly have everything. We model this by returning '*'.
    return new Set(['*']);
  }
  if (m.roleId) {
    const rows = await prisma.rolePermission.findMany({
      where: { roleId: m.roleId },
      select: { permission: true },
    });
    return new Set(rows.map((r) => r.permission));
  }
  const defaults =
    m.role === 'MANAGER' ? DEFAULT_MANAGER_PERMISSIONS : DEFAULT_MEMBER_PERMISSIONS;
  return new Set(defaults as readonly string[]);
}

// preHandler factory for routes. Use AFTER `requireTeamRole` so the
// membership is already on the request.
export function requirePermission(permission: Permission): preHandlerHookHandler {
  return async (request) => {
    if (!(await hasPermission(request, permission))) {
      throw Errors.forbidden(`Missing permission: ${permission}`);
    }
  };
}

// Non-HTTP variant for service-layer gates (tasksService, projectsService,
// commentsService, trashService). Same lookup order as hasPermission(), but
// takes raw params instead of a request. One DB hit per call when not
// admin; tasks that check several permissions for the same caller should
// pre-fetch via listMembershipPermissions instead.
export async function userHasPermission(
  userId: string,
  teamId: string,
  globalRole: GlobalRole,
  permission: Permission,
): Promise<boolean> {
  if (globalRole === 'ADMIN') return true;
  const systemUserId = await getSystemUserId();
  if (isSystemUserId(userId, systemUserId) && systemUserHasManagerPermission(permission)) {
    return true;
  }
  const m = await resolveTeamMembership(userId, teamId);
  if (!m) return false;
  if (m.roleId) {
    const row = await prisma.rolePermission.findUnique({
      where: { roleId_permission: { roleId: m.roleId, permission } },
      select: { roleId: true },
    });
    return !!row;
  }
  const defaults =
    m.role === 'MANAGER' ? DEFAULT_MANAGER_PERMISSIONS : DEFAULT_MEMBER_PERMISSIONS;
  return (defaults as readonly string[]).includes(permission);
}
