import type { GlobalRole, Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { listMembershipPermissions } from '../middleware/requirePermission.js';

/** Why the caller is asking — view includes manager rename visibility; nested is owner-equivalent task access. */
export type ProjectAccessIntent = 'view' | 'nested';

async function callerHasProjectEdit(
  teamId: string,
  callerUserId: string,
  callerGlobalRole: GlobalRole,
): Promise<boolean> {
  if (callerGlobalRole === 'ADMIN') return true;
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: callerUserId, teamId } },
  });
  if (!membership) return false;
  const perms = await listMembershipPermissions(membership, callerGlobalRole);
  return perms.has('*') || perms.has('project.edit');
}

/** Project ids in `teamId` granted to `userId` via a group membership. */
export async function groupGrantedProjectIdsInTeam(
  teamId: string,
  userId: string,
): Promise<string[]> {
  const rows = await prisma.projectGroupGrant.findMany({
    where: {
      project: { teamId },
      group: { teamId, members: { some: { userId } } },
    },
    select: { projectId: true },
  });
  return rows.map((r) => r.projectId);
}

/** All project ids granted to `userId` via any of their groups (team-scoped in queries). */
export async function groupGrantedProjectIdsForUser(userId: string): Promise<string[]> {
  const rows = await prisma.projectGroupGrant.findMany({
    where: { group: { members: { some: { userId } } } },
    select: { projectId: true },
  });
  return [...new Set(rows.map((r) => r.projectId))];
}

async function userHasGroupGrant(
  userId: string,
  projectId: string,
  teamId: string,
): Promise<boolean> {
  const row = await prisma.projectGroupGrant.findFirst({
    where: {
      projectId,
      project: { teamId },
      group: { teamId, members: { some: { userId } } },
    },
    select: { projectId: true },
  });
  return !!row;
}

/**
 * Unified project-access check used by list/get, nested routes, and middleware.
 *   - ADMIN → always
 *   - owner → always
 *   - project.edit manager → view only (rename visibility, not nested routes)
 *   - group grant → view + nested (owner-equivalent for tasks/comments/…)
 */
export async function userCanAccessProject(
  projectId: string,
  teamId: string,
  userId: string,
  globalRole: GlobalRole,
  intent: ProjectAccessIntent,
): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { teamId: true, ownerId: true },
  });
  if (!project || project.teamId !== teamId) return false;
  if (globalRole === 'ADMIN') return true;
  if (project.ownerId === userId) return true;
  if (intent === 'view' && (await callerHasProjectEdit(teamId, userId, globalRole))) {
    return true;
  }
  return userHasGroupGrant(userId, projectId, teamId);
}

/** Prisma filter for GET /teams/:teamId/projects list. */
export async function projectListWhereForCaller(
  teamId: string,
  userId: string,
  globalRole: GlobalRole,
): Promise<Prisma.ProjectWhereInput> {
  if (globalRole === 'ADMIN') return { teamId };
  if (await callerHasProjectEdit(teamId, userId, globalRole)) return { teamId };

  const groupIds = await groupGrantedProjectIdsInTeam(teamId, userId);
  return {
    teamId,
    OR: [
      { ownerId: userId },
      ...(groupIds.length ? [{ id: { in: groupIds } }] : []),
    ],
  };
}

/** Prisma filter for GET /api/projects cross-team list. */
export async function projectListAllWhereForCaller(
  userId: string,
  globalRole: GlobalRole,
): Promise<Prisma.ProjectWhereInput> {
  if (globalRole === 'ADMIN') return {};

  const memberships = await prisma.teamMembership.findMany({
    where: { userId },
  });
  const memberTeamIds = memberships.map((m) => m.teamId);
  const editTeamIds: string[] = [];
  for (const m of memberships) {
    const perms = await listMembershipPermissions(m, globalRole);
    if (perms.has('*') || perms.has('project.edit')) editTeamIds.push(m.teamId);
  }

  const groupIds = await groupGrantedProjectIdsForUser(userId);
  const orClauses: Prisma.ProjectWhereInput[] = [
    { ownerId: userId, teamId: { in: memberTeamIds } },
  ];
  if (editTeamIds.length) orClauses.push({ teamId: { in: editTeamIds } });
  if (groupIds.length) {
    orClauses.push({ id: { in: groupIds }, teamId: { in: memberTeamIds } });
  }
  return { OR: orClauses };
}
