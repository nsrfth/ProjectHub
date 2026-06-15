import type { GlobalRole, Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { listMembershipPermissions } from '../middleware/requirePermission.js';

export type ProjectAccessLevel = 'NONE' | 'READ' | 'WRITE';

/** view = list/get/rename visibility; nested = tasks/comments/… routes */
export type ProjectAccessScope = 'view' | 'nested';

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

async function groupAccessForProject(
  userId: string,
  projectId: string,
  teamId: string,
): Promise<'NONE' | 'READ' | 'WRITE'> {
  const rows = await prisma.userGroupMember.findMany({
    where: {
      userId,
      status: 'ACCEPTED',
      group: {
        teamId,
        grants: { some: { projectId } },
      },
    },
    select: { accessLevel: true },
  });
  if (!rows.length) return 'NONE';
  if (rows.some((r) => r.accessLevel === 'FULL')) return 'WRITE';
  return 'READ';
}

/** Accepted group-granted project ids for a user in one team (view scope). */
export async function groupGrantedProjectIdsInTeam(
  teamId: string,
  userId: string,
): Promise<string[]> {
  const rows = await prisma.projectGroupGrant.findMany({
    where: {
      project: { teamId },
      group: {
        teamId,
        members: { some: { userId, status: 'ACCEPTED' } },
      },
    },
    select: { projectId: true },
  });
  return rows.map((r) => r.projectId);
}

/** All accepted group-granted project ids (any team). */
export async function groupGrantedProjectIdsForUser(userId: string): Promise<string[]> {
  const rows = await prisma.projectGroupGrant.findMany({
    where: {
      group: { members: { some: { userId, status: 'ACCEPTED' } } },
    },
    select: { projectId: true },
  });
  return [...new Set(rows.map((r) => r.projectId))];
}

function maxAccess(a: ProjectAccessLevel, b: ProjectAccessLevel): ProjectAccessLevel {
  const rank = { NONE: 0, READ: 1, WRITE: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Unified project-access resolver.
 *   ADMIN / owner → WRITE
 *   project.edit manager → READ in view scope only (list/rename visibility; not nested)
 *   ACCEPTED group grant → FULL=WRITE, READONLY=READ
 */
export async function resolveProjectAccess(
  projectId: string,
  teamId: string,
  userId: string,
  globalRole: GlobalRole,
  scope: ProjectAccessScope = 'nested',
): Promise<ProjectAccessLevel> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { teamId: true, ownerId: true },
  });
  if (!project || project.teamId !== teamId) return 'NONE';
  if (globalRole === 'ADMIN') return 'WRITE';
  if (project.ownerId === userId) return 'WRITE';

  let access: ProjectAccessLevel = 'NONE';

  if (scope === 'view' && (await callerHasProjectEdit(teamId, userId, globalRole))) {
    access = maxAccess(access, 'READ');
  }

  const groupAccess = await groupAccessForProject(userId, projectId, teamId);
  access = maxAccess(access, groupAccess);

  return access;
}

export interface TaskResponsibleCandidate {
  userId: string;
  name: string;
  email: string;
}

/** Team members ∪ accepted group members granted this project (excludes system users). */
export async function listEligibleTaskResponsibleCandidates(
  teamId: string,
  projectId: string,
): Promise<TaskResponsibleCandidate[]> {
  const byUserId = new Map<string, TaskResponsibleCandidate>();

  const memberships = await prisma.teamMembership.findMany({
    where: { teamId, user: { isSystemUser: false } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  for (const m of memberships) {
    byUserId.set(m.userId, {
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
    });
  }

  const groupMembers = await prisma.userGroupMember.findMany({
    where: {
      status: 'ACCEPTED',
      user: { isSystemUser: false },
      group: {
        teamId,
        grants: { some: { projectId } },
      },
    },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  for (const gm of groupMembers) {
    if (!byUserId.has(gm.userId)) {
      byUserId.set(gm.userId, {
        userId: gm.user.id,
        name: gm.user.name,
        email: gm.user.email,
      });
    }
  }

  return [...byUserId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

export async function isUserEligibleTaskResponsible(
  teamId: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const membership = await prisma.teamMembership.findFirst({
    where: { teamId, userId, user: { isSystemUser: false } },
  });
  if (membership) return true;

  const groupMember = await prisma.userGroupMember.findFirst({
    where: {
      userId,
      status: 'ACCEPTED',
      user: { isSystemUser: false },
      group: {
        teamId,
        grants: { some: { projectId } },
      },
    },
  });
  return !!groupMember;
}

export async function assertCanWriteProject(
  projectId: string,
  teamId: string,
  userId: string,
  globalRole: GlobalRole,
): Promise<void> {
  const access = await resolveProjectAccess(projectId, teamId, userId, globalRole, 'nested');
  if (access === 'NONE') throw Errors.notFound('Project not found');
  if (access === 'READ') throw Errors.forbidden('Read-only access to this project');
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
  if (groupIds.length) orClauses.push({ id: { in: groupIds } });
  return { OR: orClauses };
}
