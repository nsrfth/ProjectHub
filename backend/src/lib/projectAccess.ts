import type { GlobalRole, Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { getDelegateCapabilities } from './delegateCaps.js';
import { listMembershipPermissions } from '../middleware/requirePermission.js';
import { loadEnv } from '../config/env.js';
import {
  grantAccessForProject,
  grantedProjectIdsInTeam,
  recordDivergence,
  resolveGrantSubjects,
} from './projectGrants.js';

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
  // v2.6 (Phase 2): three-position flag walk. See config/env.ts.
  const mode = loadEnv().ACCESS_UNIFIED_GRANTS;

  if (mode === 'off') {
    return resolveProjectAccessLegacy(projectId, teamId, userId, globalRole, scope);
  }

  if (mode === 'on') {
    return resolveProjectAccessUnified(projectId, teamId, userId, globalRole, scope);
  }

  // dual: run both, RETURN THE LEGACY ANSWER, log disagreements.
  //
  // Returning legacy is the entire safety property of this mode — behaviour is
  // bit-identical to `off`, so a bug in the new resolver cannot lock anyone out
  // or let anyone in while we are still measuring it.
  const legacy = await resolveProjectAccessLegacy(projectId, teamId, userId, globalRole, scope);
  try {
    const unified = await resolveProjectAccessUnified(projectId, teamId, userId, globalRole, scope);
    if (unified !== legacy) {
      await recordDivergence({ projectId, teamId, userId, globalRole, scope }, legacy, unified);
    }
  } catch {
    // A throw in the shadow path must never fail a request that the legacy
    // resolver already answered.
  }
  return legacy;
}

/**
 * v2.6 (Phase 2): unified resolution.
 *
 * The caller-derived rungs (ADMIN, owner, write_all, read_all, project.edit,
 * delegate capabilities) are IDENTICAL to legacy and deliberately duplicated
 * rather than shared — during dual mode the two functions must be able to
 * disagree, and a shared helper would mask exactly the class of bug we are
 * watching for. They converge again in Phase 6 when legacy is deleted.
 *
 * What changes: the three grant rungs (group grant, team share, delegate
 * access) collapse into one `ProjectAccessGrant` lookup.
 */
async function resolveProjectAccessUnified(
  projectId: string,
  teamId: string,
  userId: string,
  globalRole: GlobalRole,
  scope: ProjectAccessScope,
): Promise<ProjectAccessLevel> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { teamId: true, ownerId: true },
  });
  if (!project || project.teamId !== teamId) return 'NONE';
  if (globalRole === 'ADMIN') return 'WRITE';
  if (project.ownerId === userId) return 'WRITE';

  // Preserved deliberately: `project.write_all` early-returns WRITE on every
  // team project. This makes Phase 3's acceptance flows structurally
  // inapplicable to department managers — which is consistent with Phase 3's
  // skip rule, and is documented here so nobody "fixes" it later.
  if (await callerHasWriteAll(teamId, userId, globalRole)) return 'WRITE';

  const delegateCaps = await getDelegateCapabilities(projectId, userId);
  if (delegateCaps.has('FULL')) return 'WRITE';

  let access: ProjectAccessLevel = delegateCaps.size > 0 ? 'READ' : 'NONE';

  // Note on the `read_all` "never escalates to WRITE" comment in the legacy
  // path: that is true of this RUNG, not of the resolver's final value. A
  // read_all holder who also holds a WRITE grant still ends up with WRITE, via
  // maxAccess below. Both resolvers behave this way; it is not a divergence.
  if (await callerHasReadAll(teamId, userId, globalRole)) {
    access = maxAccess(access, 'READ');
  }

  if (scope === 'view' && (await callerHasProjectEdit(teamId, userId, globalRole))) {
    access = maxAccess(access, 'READ');
  }

  const subjects = await resolveGrantSubjects(userId);
  return maxAccess(access, await grantAccessForProject(projectId, subjects));
}

async function resolveProjectAccessLegacy(
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

/**
 * v2.6 (Phase 1C): the unit-scope condition.
 *
 * Layered ON TOP of eligibility, never instead of it. Eligibility answers "may
 * this person hold a role on this project at all" (team member, granted group
 * member, FULL-shared guest team). Scope answers "may THIS assigner give it to
 * them". A user must pass both.
 *
 * Returns true (permit) when:
 *   - the flag is off — the entire feature is inert
 *   - the assigner holds `task.assign_any` — the manager tier, unrestricted
 *   - assigner and target share a unit in this team
 *   - the TARGET has no unit at all
 *
 * That last clause is the deliberate degradation, and it is the difference
 * between a system that fails safe and one that fails useless. A person the
 * directory sync could not place in a unit would otherwise be assignable by
 * NOBODY — and the population most likely to lack a unit is exactly the field
 * staff this programme exists to serve. Instead they stay assignable by
 * `task.assign_any` holders and appear on the unit-coverage exception report.
 *
 * Note the asymmetry: an ASSIGNER with no unit can still only assign unitless
 * targets, because the shared-unit test fails for everyone else. That is
 * intentional — an unscoped assigner is not a super-user.
 */
export async function isWithinAssignmentScope(
  teamId: string,
  assignerUserId: string,
  targetUserId: string,
  assignerGlobalRole: GlobalRole,
): Promise<boolean> {
  if (!loadEnv().ACCESS_UNIT_SCOPE) return true;
  if (assignerGlobalRole === 'ADMIN') return true;
  if (assignerUserId === targetUserId) return true;

  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: assignerUserId, teamId } },
  });
  if (membership) {
    const perms = await listMembershipPermissions(membership, assignerGlobalRole);
    if (perms.has('*') || perms.has('task.assign_any')) return true;
  }

  // `isUnit`/`teamId` on UserGroupMember are denormalized and trigger-maintained
  // (see the Phase 1A migration) precisely so this lookup is a single indexed
  // read on a path that runs on every assignment.
  const [assignerUnit, targetUnit] = await Promise.all([
    prisma.userGroupMember.findFirst({
      where: { userId: assignerUserId, teamId, isUnit: true, status: 'ACCEPTED' },
      select: { groupId: true },
    }),
    prisma.userGroupMember.findFirst({
      where: { userId: targetUserId, teamId, isUnit: true, status: 'ACCEPTED' },
      select: { groupId: true },
    }),
  ]);

  // Target has no unit — assignable only by task.assign_any holders, who
  // already returned true above. Everyone else is refused here.
  if (!targetUnit) return false;
  if (!assignerUnit) return false;
  return assignerUnit.groupId === targetUnit.groupId;
}

/** The unit a user belongs to in a team, or null. Used by the exception report. */
export async function resolveUserUnit(
  teamId: string,
  userId: string,
): Promise<{ groupId: string; role: 'MANAGER' | 'MEMBER' } | null> {
  const row = await prisma.userGroupMember.findFirst({
    where: { userId, teamId, isUnit: true, status: 'ACCEPTED' },
    select: { groupId: true, role: true },
  });
  return row ? { groupId: row.groupId, role: row.role } : null;
}

/**
 * v2.6 (Phase 1C): THE assignment guard. One call, both questions:
 *
 *   eligibility — may this person hold a role on this project at all?
 *                 (team member ∪ ACCEPTED granted-group member ∪ FULL-shared
 *                 guest-team member — `isUserEligibleTaskResponsible`)
 *   scope       — may THIS actor give it to them? (`isWithinAssignmentScope`)
 *
 * Every task/subtask assignee and responsible write goes through here, which
 * ends the drift that motivated the unification: three services each carried
 * their own inline membership check, all subtly different —
 *
 *   - subtasks' `assertAssigneeInTeam`: bare team membership. A user with
 *     legitimate WRITE via a group grant could not be a subtask assignee.
 *   - tasks' inline assignee check: team membership OR FULL-shared guest.
 *     Group-grant members excluded here too.
 *   - tasks' responsible check: the full eligibility rule.
 *
 * Unifying on the full rule deliberately LOOSENS the first two — a group-grant
 * member with project access is now assignable, matching the responsible rule.
 * That loosening is intended and recorded in the plan (Phase 1C).
 *
 * Approvers are NOT routed through the scope half (eligibility only, at the
 * call sites): an approver is a governance role, not an assignment of daily
 * work, and gating who may be *asked to approve* by unit would let unit
 * boundaries break the approval chain.
 */
export async function assertAssignmentAllowed(opts: {
  teamId: string;
  projectId: string;
  actorId: string;
  actorGlobalRole: GlobalRole;
  targetId: string | null | undefined;
  /** Only for the error message — the rules are identical for both roles. */
  role: 'assignee' | 'responsible';
}): Promise<void> {
  const { teamId, projectId, actorId, actorGlobalRole, targetId, role } = opts;
  // Clearing (null) and omitting (undefined) are always allowed — un-assigning
  // someone is never an act the scope rule should block.
  if (targetId === null || targetId === undefined) return;

  const eligible = await isUserEligibleTaskResponsible(teamId, projectId, targetId);
  if (!eligible) {
    throw Errors.badRequest(
      role === 'assignee'
        ? 'Assignee is not eligible for this project'
        : 'Responsible is not eligible for this project',
    );
  }

  const inScope = await isWithinAssignmentScope(teamId, actorId, targetId, actorGlobalRole);
  if (!inScope) throw Errors.assigneeOutOfScope();
}

/**
 * v2.6 (Phase 1C): batch scope filter for the responsible-candidates picker.
 *
 * The picker must not offer people the subsequent write would reject with
 * ASSIGNEE_OUT_OF_SCOPE — a dropdown of guaranteed errors is how a scoping
 * rule turns into a support ticket. Same rules as `isWithinAssignmentScope`,
 * but two queries for the whole candidate list instead of three per candidate.
 */
export async function filterCandidatesToAssignerScope(
  teamId: string,
  assignerUserId: string,
  assignerGlobalRole: GlobalRole,
  candidates: TaskResponsibleCandidate[],
): Promise<TaskResponsibleCandidate[]> {
  if (!loadEnv().ACCESS_UNIT_SCOPE) return candidates;
  if (assignerGlobalRole === 'ADMIN') return candidates;

  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: assignerUserId, teamId } },
  });
  if (membership) {
    const perms = await listMembershipPermissions(membership, assignerGlobalRole);
    if (perms.has('*') || perms.has('task.assign_any')) return candidates;
  }

  const unitRows = await prisma.userGroupMember.findMany({
    where: {
      teamId,
      isUnit: true,
      status: 'ACCEPTED',
      userId: { in: [assignerUserId, ...candidates.map((c) => c.userId)] },
    },
    select: { userId: true, groupId: true },
  });
  const unitByUser = new Map(unitRows.map((r) => [r.userId, r.groupId]));
  const assignerUnit = unitByUser.get(assignerUserId);

  // Mirrors isWithinAssignmentScope exactly: self always; same unit when the
  // assigner has one; unitless candidates are assign_any-only, and assign_any
  // holders already returned above — so they are filtered here.
  return candidates.filter((c) => {
    if (c.userId === assignerUserId) return true;
    if (!assignerUnit) return false;
    return unitByUser.get(c.userId) === assignerUnit;
  });
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

  // v2.6 (Phase 2): the list filter MUST agree with resolveProjectAccess, or a
  // project appears in the list and then 404s when opened (or worse, the
  // reverse). Under `on` the grant table is the single source for both.
  //
  // `dual` uses the legacy filter, matching the resolver's dual behaviour —
  // divergence is measured on the resolver, which is the authorization
  // decision; the list is a projection of it.
  if (loadEnv().ACCESS_UNIFIED_GRANTS === 'on') {
    const subjects = await resolveGrantSubjects(userId);
    const grantedIds = await grantedProjectIdsInTeam(teamId, subjects);
    return {
      OR: [
        { teamId, ownerId: userId },
        ...(grantedIds.length ? [{ id: { in: grantedIds } }] : []),
      ],
    };
  }

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
