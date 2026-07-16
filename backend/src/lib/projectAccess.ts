import type { GlobalRole, Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { getDelegateCapabilities } from './delegateCaps.js';
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

// v1.79: does the caller's membership in `teamId` grant team-wide project
// WRITE (`project.write_all`)? Mirrors `callerHasProjectEdit` but checks the
// distinct write permission. A holder gets WRITE to EVERY project in this team
// in both view and nested scope — the path that lets a manager add/modify
// tasks in a team project they don't own.
async function callerHasWriteAll(
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
  return perms.has('*') || perms.has('project.write_all');
}

// v2.5.54: does the caller's membership in `teamId` grant team-wide project
// READ (`project.read_all`)? The read-only twin of `callerHasWriteAll` — a
// holder (e.g. a PMO oversight role) gets READ to EVERY project in this team in
// both view and nested scope, but never WRITE.
async function callerHasReadAll(
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
  return perms.has('*') || perms.has('project.read_all');
}

// v2.5.58: whole-team project sharing (ProjectTeamShare). A share mounts the
// project into a guest team: EVERY member of that team gets READ (READONLY) or
// WRITE (FULL). Access flows through the project's HOME-team URLs — like group
// grants — so Task.teamId denormalization and all task services stay untouched.
async function teamShareAccessForProject(
  userId: string,
  projectId: string,
): Promise<'NONE' | 'READ' | 'WRITE'> {
  const shares = await prisma.projectTeamShare.findMany({
    where: { projectId },
    select: { teamId: true, level: true },
  });
  if (!shares.length) return 'NONE';
  const memberships = await prisma.teamMembership.findMany({
    where: { userId, teamId: { in: shares.map((s) => s.teamId) } },
    select: { teamId: true },
  });
  const memberTeamIds = new Set(memberships.map((m) => m.teamId));
  let access: 'NONE' | 'READ' | 'WRITE' = 'NONE';
  for (const s of shares) {
    if (!memberTeamIds.has(s.teamId)) continue;
    if (s.level === 'FULL') return 'WRITE';
    access = 'READ';
  }
  return access;
}

/** Project ids shared (ProjectTeamShare) to any of the given teams. */
export async function teamSharedProjectIds(teamIds: string[]): Promise<string[]> {
  if (!teamIds.length) return [];
  const rows = await prisma.projectTeamShare.findMany({
    where: { teamId: { in: teamIds } },
    select: { projectId: true },
  });
  return [...new Set(rows.map((r) => r.projectId))];
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
 *   project.write_all → WRITE in BOTH view and nested scope (v1.79)
 *   project.read_all → READ in BOTH scopes (v2.5.54, PMO oversight; never WRITE)
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

  // v1.79: team-wide write permission. Evaluated only after the teamId match
  // above, so it can never leak across teams. Grants WRITE in both scopes —
  // this is what lets a manager add/modify tasks in a team project they don't
  // own (fixes the "Project not found" 404 on nested writes).
  if (await callerHasWriteAll(teamId, userId, globalRole)) return 'WRITE';

  // v1.86: a per-project full-edit delegate gets WRITE so they can actually
  // reach + edit this project's tasks/subtasks. This grants ACCESS only to the
  // named delegate — it does NOT loosen the manager-only date gate or the
  // task.change_responsible gate for anyone else (those are lifted separately,
  // and only for the delegate, in tasks/subtasksService). The project-settings
  // edit gate (projectsService.update) is unaffected — a delegate still can't
  // rename/reassign the project.
  // v1.88: a FULL delegate keeps project WRITE (old behavior); a partial
  // (granular) delegate gets READ so they can view the project's tasks — their
  // specific edit capabilities are then enforced field-by-field in
  // tasks/subtasksService. A non-delegate gets NONE here.
  const delegateCaps = await getDelegateCapabilities(projectId, userId);
  if (delegateCaps.has('FULL')) return 'WRITE';

  let access: ProjectAccessLevel = delegateCaps.size > 0 ? 'READ' : 'NONE';

  // v2.5.54: team-wide READ oversight (PMO). Unlike `project.edit` (view-scope
  // only), `project.read_all` grants READ in BOTH scopes so a PMO can open any
  // team project's nested tasks/comments read-only. `maxAccess` can never lower
  // a WRITE — and owner / write_all / FULL-delegate already returned above — so
  // in practice this only lifts NONE→READ. It never yields WRITE.
  if (await callerHasReadAll(teamId, userId, globalRole)) {
    access = maxAccess(access, 'READ');
  }

  if (scope === 'view' && (await callerHasProjectEdit(teamId, userId, globalRole))) {
    access = maxAccess(access, 'READ');
  }

  const groupAccess = await groupAccessForProject(userId, projectId, teamId);
  access = maxAccess(access, groupAccess);

  // v2.5.58: whole-team shares — a member of any guest team this project is
  // shared with gets FULL=WRITE / READONLY=READ, in both scopes.
  const shareAccess = await teamShareAccessForProject(userId, projectId);
  access = maxAccess(access, shareAccess);

  return access;
}

// v1.86: per-project "full-edit" delegation (ProjectEditDelegate). Deliberately
// SEPARATE from resolveProjectAccess: project WRITE/group-FULL must NOT bypass
// the manager-only date gate or the task.change_responsible gate, so this is its
// own explicit, narrow elevation signal keyed by (projectId, userId). A delegate
// on project A is never elevated on project B.
// v1.88: now means "holds the FULL capability" — the old all-or-nothing
// full-edit semantics. Used where a delegate must be fully privileged (the
// approval finalizer; project WRITE). Partial/granular delegates return false;
// their narrow capabilities are checked via getDelegateCapabilities instead.
export async function isProjectEditDelegate(
  projectId: string,
  userId: string,
): Promise<boolean> {
  return (await getDelegateCapabilities(projectId, userId)).has('FULL');
}

/** The userIds delegated full-edit on this project (owner-facing list + UI gate). */
export async function listProjectDelegateIds(projectId: string): Promise<string[]> {
  const rows = await prisma.projectEditDelegate.findMany({
    where: { projectId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
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

  // v2.5.58: members of FULL-shared guest teams can hold task roles too
  // (READONLY teams stay read-only, so their members are not offered).
  const sharedMembers = await prisma.teamMembership.findMany({
    where: {
      user: { isSystemUser: false },
      team: { projectShares: { some: { projectId, level: 'FULL' } } },
    },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  for (const sm of sharedMembers) {
    if (!byUserId.has(sm.userId)) {
      byUserId.set(sm.userId, {
        userId: sm.user.id,
        name: sm.user.name,
        email: sm.user.email,
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
  if (groupMember) return true;

  // v2.5.58: member of a FULL-shared guest team.
  const sharedMember = await prisma.teamMembership.findFirst({
    where: {
      userId,
      user: { isSystemUser: false },
      team: { projectShares: { some: { projectId, level: 'FULL' } } },
    },
  });
  return !!sharedMember;
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
  // v2.5.58: projects shared TO this team appear in its list for every team
  // member (that's the whole point of a whole-team share). The caller already
  // passed requireTeamRole for `teamId`, so membership is established.
  const sharedClause: Prisma.ProjectWhereInput = { teamShares: { some: { teamId } } };

  if (globalRole === 'ADMIN') return { OR: [{ teamId }, sharedClause] };
  if (await callerHasProjectEdit(teamId, userId, globalRole)) return { OR: [{ teamId }, sharedClause] };
  // v1.79: a project.write_all holder can write to every team project, so it
  // must also see every team project in the list (independent of project.edit).
  if (await callerHasWriteAll(teamId, userId, globalRole)) return { OR: [{ teamId }, sharedClause] };
  // v2.5.54: a project.read_all holder (PMO) sees every team project read-only.
  if (await callerHasReadAll(teamId, userId, globalRole)) return { OR: [{ teamId }, sharedClause] };

  const groupIds = await groupGrantedProjectIdsInTeam(teamId, userId);
  return {
    OR: [
      {
        teamId,
        OR: [
          { ownerId: userId },
          ...(groupIds.length ? [{ id: { in: groupIds } }] : []),
        ],
      },
      sharedClause,
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
  // Teams where the caller sees every project: project.edit (view visibility),
  // project.write_all (team-wide write, v1.79), or project.read_all (read-only
  // oversight / PMO, v2.5.54) all qualify.
  const editTeamIds: string[] = [];
  for (const m of memberships) {
    const perms = await listMembershipPermissions(m, globalRole);
    if (
      perms.has('*') ||
      perms.has('project.edit') ||
      perms.has('project.write_all') ||
      perms.has('project.read_all')
    ) {
      editTeamIds.push(m.teamId);
    }
  }

  const groupIds = await groupGrantedProjectIdsForUser(userId);
  const orClauses: Prisma.ProjectWhereInput[] = [
    { ownerId: userId, teamId: { in: memberTeamIds } },
  ];
  if (editTeamIds.length) orClauses.push({ teamId: { in: editTeamIds } });
  if (groupIds.length) orClauses.push({ id: { in: groupIds } });
  // v2.5.58: whole-team shares — projects shared to any of the caller's teams.
  if (memberTeamIds.length) {
    orClauses.push({ teamShares: { some: { teamId: { in: memberTeamIds } } } });
  }
  return { OR: orClauses };
}
