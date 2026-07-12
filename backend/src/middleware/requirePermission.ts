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

// v2.5.54: permission check that is NOT tied to a single `:teamId` path param.
// The portfolio / org-unit tree routes are global (they run only `requireAuth`,
// with no `requireTeamRole`), so `request.membership` is never populated and the
// standard `hasPermission` denies every non-admin. This variant asks "does the
// caller hold `permission` via ANY of their team roles?" — the model for an
// org-wide capability (e.g. a PMO viewing the cross-team portfolio roll-ups)
// that a non-admin can legitimately hold through a per-team role assignment.
export async function userHasPermissionAnyTeam(
  userId: string,
  globalRole: GlobalRole,
  permission: Permission,
): Promise<boolean> {
  if (globalRole === 'ADMIN') return true;
  const memberships = await prisma.teamMembership.findMany({
    where: { userId },
    select: { roleId: true, role: true },
  });
  if (!memberships.length) return false;

  const roleIds = memberships.map((m) => m.roleId).filter((id): id is string => !!id);
  if (roleIds.length) {
    const row = await prisma.rolePermission.findFirst({
      where: { roleId: { in: roleIds }, permission },
      select: { roleId: true },
    });
    if (row) return true;
  }

  // Legacy fallback for any membership whose roleId was never backfilled.
  return memberships.some(
    (m) =>
      !m.roleId &&
      (
        (m.role === 'MANAGER'
          ? DEFAULT_MANAGER_PERMISSIONS
          : DEFAULT_MEMBER_PERMISSIONS) as readonly string[]
      ).includes(permission),
  );
}

// preHandler factory for GLOBAL (non-team-scoped) routes — pairs with
// `userHasPermissionAnyTeam`. Runs after `requireAuth`; needs no membership on
// the request.
export function requirePermissionAnyTeam(permission: Permission): preHandlerHookHandler {
  return async (request) => {
    if (!request.user) throw Errors.unauthorized();
    if (!(await userHasPermissionAnyTeam(request.user.sub, request.user.globalRole, permission))) {
      throw Errors.forbidden(`Missing permission: ${permission}`);
    }
  };
}
