import type { GlobalRole, Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import type { ProjectAccessLevel, ProjectAccessScope } from './projectAccess.js';

// v2.6 (Phase 2): the unified grant resolver.
//
// This is the NEW path. It lives beside the legacy resolver in projectAccess.ts
// for the whole dual-read period rather than replacing it in place, because the
// only credible way to rewrite the function consulted on every authenticated
// request is to run both and compare — a diff review cannot prove parity across
// six overlapping access paths.
//
// Six paths collapse to one table:
//   ProjectGroupGrant           -> GROUP subject
//   ProjectTeamShare            -> TEAM subject
//   ProjectEditDelegate (access)-> USER subject
//   (Phase 5) org unit          -> ORG_UNIT subject
// Owner, ADMIN, and the permission-derived rungs (write_all / read_all /
// project.edit) are NOT grants — they are properties of the caller, not of the
// project, so they stay where they are and are evaluated by the caller.

/**
 * Subjects a user "is", for grant matching.
 *
 * Resolved once per access check rather than per grant: a project with twenty
 * grants would otherwise issue twenty membership lookups.
 */
export interface GrantSubjects {
  userId: string;
  groupIds: string[];
  teamIds: string[];
  orgUnitIds: string[];
}

/**
 * ACCEPTED group membership is what carries consent today — the grant itself is
 * imposed. Phase 2 preserves that exactly: a PENDING group membership yields no
 * access, same as before. Grant-level PENDING arrives in Phase 3.
 */
export async function resolveGrantSubjects(userId: string): Promise<GrantSubjects> {
  const [groups, teams, orgNodes] = await Promise.all([
    prisma.userGroupMember.findMany({
      where: { userId, status: 'ACCEPTED' },
      select: { groupId: true },
    }),
    prisma.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    }),
    // v2.9 (Phase 5): the user's org nodes, with materialized paths.
    prisma.orgUnitMembership.findMany({
      where: { userId },
      select: { orgUnit: { select: { path: true } } },
    }),
  ]);

  // Downward-only inheritance via the path: a grant on node X covers members
  // of X's whole subtree, so a user at /MDL/KVSM satisfies ORG_UNIT subjects
  // KVSM *and* MDL. The path segments ARE the ancestor ids — that is what the
  // materialized path exists for — so no recursive walk is needed, and a
  // grant on the MDL root can never reach an SBC member structurally: no SBC
  // path contains MDL's id.
  const orgUnitIds = [
    ...new Set(orgNodes.flatMap((m) => m.orgUnit.path.split('/').filter(Boolean))),
  ];

  return {
    userId,
    groupIds: groups.map((g) => g.groupId),
    teamIds: teams.map((t) => t.teamId),
    orgUnitIds,
  };
}

/**
 * v2.9 (Phase 5): apply standing org policies to a just-created project.
 *
 * Called from projectsService.create AFTER the project row exists. Applies
 * once — policies never re-materialize on edit, and deleting a policy never
 * revokes (the plan's explicit semantics; `sourcePolicyId` is what makes a
 * bad policy cleanly revocable instead).
 *
 * Grants land ACTIVE with source 'policy'. They are read only under
 * ACCESS_UNIFIED_GRANTS=on (ORG_UNIT subjects have no legacy counterpart), so
 * this is inert until Phase 2's flag walk completes — by design.
 */
export async function applyOrgGrantPolicies(
  projectId: string,
  projectOrgUnitId: string | null,
): Promise<number> {
  if (!projectOrgUnitId) return 0;
  const node = await prisma.orgUnit.findUnique({
    where: { id: projectOrgUnitId },
    select: { path: true },
  });
  if (!node) return 0;

  // Policies whose anchor is the node itself or any ancestor — again the path
  // segments are exactly the candidate anchor ids.
  const anchorIds = node.path.split('/').filter(Boolean);
  const policies = await prisma.orgUnitGrantPolicy.findMany({
    where: { enabled: true, anchorOrgUnitId: { in: anchorIds } },
  });

  let applied = 0;
  for (const p of policies) {
    await prisma.projectAccessGrant.upsert({
      where: {
        projectId_subjectType_subjectId_level: {
          projectId, subjectType: p.subjectType, subjectId: p.subjectId, level: p.level,
        },
      },
      update: {},
      create: {
        projectId,
        subjectType: p.subjectType,
        subjectId: p.subjectId,
        level: p.level,
        status: 'ACTIVE',
        source: 'policy',
        sourcePolicyId: p.id,
      },
    });
    applied += 1;
  }
  return applied;
}

/** Prisma OR-clause matching every grant subject this user satisfies. */
function subjectClause(s: GrantSubjects): Prisma.ProjectAccessGrantWhereInput[] {
  const clauses: Prisma.ProjectAccessGrantWhereInput[] = [
    { subjectType: 'USER', subjectId: s.userId },
  ];
  if (s.groupIds.length) clauses.push({ subjectType: 'GROUP', subjectId: { in: s.groupIds } });
  if (s.teamIds.length) clauses.push({ subjectType: 'TEAM', subjectId: { in: s.teamIds } });
  if (s.orgUnitIds.length) {
    clauses.push({ subjectType: 'ORG_UNIT', subjectId: { in: s.orgUnitIds } });
  }
  return clauses;
}

/**
 * Where-clause matching only the grants that actually apply to this user right
 * now: ACTIVE, unexpired, and held by one of their subjects.
 *
 * Expiry is evaluated here rather than swept by a job on purpose: an expired
 * grant must stop working at the instant it expires, not at the next sweep.
 * A sweep would leave a window where a revoked collaborator still has access,
 * which is exactly what an access review would flag.
 *
 * BOTH conditions are composed under `AND` because each is an OR-set, and two
 * `OR` keys cannot coexist in one Prisma where object. An earlier version
 * spread one in and then wrote the other:
 *
 *     { projectId, ...liveGrantWhere(now), OR: subjectClause(subjects) }
 *
 * — where the second `OR` silently overwrote the first, discarding the expiry
 * filter entirely and leaving expired grants fully effective. It type-checked
 * and 32 of 33 tests still passed. Keep the two OR-sets nested under AND.
 */
function liveGrantWhere(
  subjects: GrantSubjects,
  now: Date,
): Prisma.ProjectAccessGrantWhereInput {
  return {
    status: 'ACTIVE',
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      { OR: subjectClause(subjects) },
    ],
  };
}

/**
 * The grant-derived access level for one project.
 *
 * Returns only what the GRANT TABLE says. Owner / ADMIN / permission rungs are
 * the caller's job — keeping them out means this function has exactly one
 * responsibility and the dual-read comparison stays meaningful.
 */
export async function grantAccessForProject(
  projectId: string,
  subjects: GrantSubjects,
  now: Date = new Date(),
): Promise<ProjectAccessLevel> {
  const rows = await prisma.projectAccessGrant.findMany({
    where: { projectId, ...liveGrantWhere(subjects, now) },
    select: { level: true },
  });
  if (!rows.length) return 'NONE';
  return rows.some((r) => r.level === 'WRITE') ? 'WRITE' : 'READ';
}

/** Project ids this user reaches through any live grant. */
export async function grantedProjectIds(
  subjects: GrantSubjects,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await prisma.projectAccessGrant.findMany({
    where: liveGrantWhere(subjects, now),
    select: { projectId: true },
  });
  return [...new Set(rows.map((r) => r.projectId))];
}

/** Project ids this user reaches through a live grant, restricted to one team. */
export async function grantedProjectIdsInTeam(
  teamId: string,
  subjects: GrantSubjects,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await prisma.projectAccessGrant.findMany({
    where: { ...liveGrantWhere(subjects, now), project: { teamId } },
    select: { projectId: true },
  });
  return [...new Set(rows.map((r) => r.projectId))];
}

// ---------------------------------------------------------------------------
// Divergence logging
// ---------------------------------------------------------------------------

export interface DivergenceContext {
  projectId: string;
  teamId: string;
  userId: string;
  globalRole: GlobalRole;
  scope: ProjectAccessScope;
}

/**
 * Records a legacy-vs-unified disagreement during `dual` mode.
 *
 * Written to SecurityAuditEvent rather than only to the log stream because the
 * phase exit criterion is "zero unexplained divergence entries over two weeks",
 * and that has to be queryable after the fact. Log lines get rotated away;
 * production here has no log aggregation (risk R-4).
 *
 * Deliberately best-effort: a failure to record a divergence must never fail
 * the request that triggered it. The whole point of `dual` is that it is
 * invisible to users.
 */
export async function recordDivergence(
  ctx: DivergenceContext,
  legacy: ProjectAccessLevel,
  unified: ProjectAccessLevel,
): Promise<void> {
  try {
    await prisma.securityAuditEvent.create({
      data: {
        kind: 'access.divergence',
        actorId: ctx.userId,
        details: {
          projectId: ctx.projectId,
          teamId: ctx.teamId,
          scope: ctx.scope,
          globalRole: ctx.globalRole,
          legacy,
          unified,
          // Which direction matters: unified being MORE permissive is a
          // potential privilege escalation and must block the flag walk;
          // unified being LESS permissive is a potential lockout. Both are
          // bugs, but they get triaged differently.
          direction:
            rank(unified) > rank(legacy) ? 'unified_more_permissive' : 'unified_less_permissive',
        },
      },
    });
  } catch {
    // Swallowed by design — see above.
  }
}

function rank(a: ProjectAccessLevel): number {
  return a === 'WRITE' ? 2 : a === 'READ' ? 1 : 0;
}
