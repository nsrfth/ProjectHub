import { Prisma, type Currency, type GlobalRole, type ProjectStatus, type RagStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import {
  calendarDateToIso,
  normalizeOptionalCalendarDate,
} from '../lib/calendarDate.js';
import { Errors } from '../lib/errors.js';
import {
  assertCanWriteProject as assertProjectWrite,
  projectListAllWhereForCaller,
  projectListWhereForCaller,
  resolveProjectAccess,
} from '../lib/projectAccess.js';
import { getDelegateCapabilities } from '../lib/delegateCaps.js';
import { logActivity } from './activityLogger.js';
import { listMembershipPermissions, userHasPermission } from '../middleware/requirePermission.js';
import { loadEnv } from '../config/env.js';
import { ProfilesService } from './profilesService.js';
// Project visibility (additive):
// - globalRole === 'ADMIN' → all projects
// - owner → own project (full edit + nested routes)
// - project.edit manager → see all team projects; rename others (name only)
// - group grant → see + nested routes (owner-equivalent for tasks/…)
// - everyone else → own projects only

export interface ProjectLabelView {
  id: string;
  name: string;
  color: string;
}

export interface ProjectView {
  id: string;
  teamId: string;
  ownerId: string | null;
  accountableId: string | null;
  accountableName: string | null;
  name: string;
  code: string | null;
  description: string | null;
  status: ProjectStatus;
  plannedBudget: string | null;
  budgetCurrency: Currency;
  startDate: string | null;
  endDate: string | null;
  labels: ProjectLabelView[];
  correspondenceEnabled: boolean;
  // v2.5.58: plan freeze — see lib/projectFreeze.ts.
  datesFrozen: boolean;
  // v1.91 (PMIS R1): project health (RAG) for portfolio roll-up.
  ragStatus: RagStatus;
  ragReason: string | null;
  healthUpdatedAt: string | null;
  // v2.5.52: attached portfolio org unit (company), null when unattached.
  orgUnit: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

const projectInclude = {
  accountable: { select: { name: true } },
  labels: {
    include: { label: true },
    orderBy: { label: { name: 'asc' as const } },
  },
  // v2.5.52: portfolio org unit (company) for the projects-list card.
  orgUnit: { select: { id: true, name: true } },
} satisfies Prisma.ProjectInclude;

type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

function normaliseBudget(v: number | string | null | undefined): Prisma.Decimal | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (s.length === 0) return null;
  return new Prisma.Decimal(s);
}

function mapLabels(row: ProjectRow): ProjectLabelView[] {
  return row.labels.map((pl) => ({
    id: pl.label.id,
    name: pl.label.name,
    color: pl.label.color,
  }));
}

function toView(p: ProjectRow): ProjectView {
  return {
    id: p.id,
    teamId: p.teamId,
    ownerId: p.ownerId,
    accountableId: p.accountableId ?? null,
    accountableName: p.accountable?.name ?? null,
    name: p.name,
    code: p.code,
    description: p.description,
    status: p.status,
    plannedBudget: p.plannedBudget === null ? null : p.plannedBudget.toFixed(2),
    budgetCurrency: p.budgetCurrency,
    startDate: calendarDateToIso(p.startDate),
    endDate: calendarDateToIso(p.endDate),
    labels: mapLabels(p),
    correspondenceEnabled: p.correspondenceEnabled,
    datesFrozen: p.datesFrozen,
    ragStatus: p.ragStatus,
    ragReason: p.ragReason,
    // healthUpdatedAt is a true instant (UTC), unlike the zone-neutral
    // calendar dates above — serialize with the timestamp formatter.
    healthUpdatedAt: p.healthUpdatedAt ? p.healthUpdatedAt.toISOString() : null,
    orgUnit: p.orgUnit ? { id: p.orgUnit.id, name: p.orgUnit.name } : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function assertDateRange(start: Date | null, end: Date | null): void {
  if (start && end && end.getTime() < start.getTime()) {
    throw Errors.badRequest('endDate must be on or after startDate');
  }
}

async function assertAccountableInTeam(
  teamId: string,
  accountableId: string | null,
): Promise<void> {
  if (accountableId === null) return;
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: accountableId, teamId } },
    select: { userId: true },
  });
  if (!membership) {
    throw Errors.badRequest('Accountable user must be a member of this team');
  }
}

// v1.85: owner = FULL project access, so a chosen owner MUST be a team member.
// Never grant ownership (and thus full access) to a user outside the team.
async function assertOwnerInTeam(teamId: string, ownerId: string | null): Promise<void> {
  if (ownerId === null) return;
  // v2.6 (Phase 1C): ownership policy — the owner must hold a manager-tier
  // role, operationalised as "a role granting project.edit". An owner without
  // it can neither manage their own project's visibility nor be the anchor the
  // access model assumes, so under unit scoping the assignment would be a
  // trap. Enforced at create/transfer only (existing violations are surfaced
  // by `npm run report:ownership`, never retroactively broken), and only while
  // the Phase 1C flag is on.
  if (loadEnv().ACCESS_UNIT_SCOPE) {
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { globalRole: true },
    });
    if (owner && owner.globalRole !== 'ADMIN') {
      const ok = await userHasPermission(ownerId, teamId, owner.globalRole, 'project.edit');
      if (!ok) {
        throw Errors.badRequest(
          'Project owner must hold a manager-tier role (one granting project.edit)',
        );
      }
    }
  }
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: ownerId, teamId } },
    select: { userId: true },
  });
  if (!membership) {
    throw Errors.badRequest('Owner must be a member of this team');
  }
}

async function assertLabelsBelongToTeam(teamId: string, labelIds: string[]): Promise<void> {
  if (labelIds.length === 0) return;
  const unique = [...new Set(labelIds)];
  const count = await prisma.label.count({
    // v1.80: accept the team's own labels OR global predefined labels (teamId NULL).
    where: { id: { in: unique }, OR: [{ teamId }, { teamId: null }] },
  });
  if (count !== unique.length) {
    throw Errors.badRequest('One or more labels do not belong to this team');
  }
}

async function syncProjectLabels(projectId: string, labelIds: string[]): Promise<void> {
  const unique = [...new Set(labelIds)];
  await prisma.$transaction(async (tx) => {
    await tx.projectLabel.deleteMany({
      where: {
        projectId,
        ...(unique.length > 0 ? { labelId: { notIn: unique } } : {}),
      },
    });
    if (unique.length > 0) {
      await tx.projectLabel.createMany({
        data: unique.map((labelId) => ({ projectId, labelId })),
        skipDuplicates: true,
      });
    }
  });
}

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

function updateTouchesNonNameFields(input: {
  code?: string | null;
  description?: string | null;
  status?: ProjectStatus;
  ownerId?: string | null;
  accountableId?: string | null;
  plannedBudget?: number | string | null;
  budgetCurrency?: Currency;
  startDate?: string | null;
  endDate?: string | null;
  labelIds?: string[];
  datesFrozen?: boolean;
}): boolean {
  return (
    input.code !== undefined
    || input.description !== undefined
    || input.status !== undefined
    // v1.86: owner reassignment is a non-name field — a rename-only manager
    // must NOT be able to hand the project (and its FULL access) to anyone.
    || input.ownerId !== undefined
    || input.accountableId !== undefined
    || input.plannedBudget !== undefined
    || input.budgetCurrency !== undefined
    || input.startDate !== undefined
    || input.endDate !== undefined
    || input.labelIds !== undefined
    // v2.5.58: the plan-freeze toggle is owner/admin-only, like dates.
    || input.datesFrozen !== undefined
  );
}

// v1.92 (PMIS R1): a duplicate project `code` within a team trips the
// @@unique([teamId, code]) constraint → Prisma P2002. Surface it as a clean 409
// instead of leaking a 500. Project has no other writable unique constraint, so
// a P2002 from a project write is always the code clash.
function rethrowProjectCodeConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw Errors.conflict('A project with this code already exists in this team');
  }
  throw err;
}

export class ProjectsService {
  async create(
    // `creatorId` is the authenticated requester — the DEFAULT owner, NOT
    // necessarily the final one. A client-supplied `input.ownerId` overrides it
    // (validated to a team member); the two stay distinct.
    teamId: string,
    creatorId: string,
    input: {
      name: string;
      code?: string | null;
      description?: string;
      status?: ProjectStatus;
      ownerId?: string | null;
      accountableId?: string | null;
      plannedBudget?: number | string | null;
      budgetCurrency?: Currency;
      startDate?: string | null;
      endDate?: string | null;
      labelIds?: string[];
      profileId?: string;
    },
  ): Promise<ProjectView> {
    // v1.85: honor a selectable owner. Effective owner = chosen owner (when
    // provided) else the creator. A chosen owner must be a team member (owner
    // grants FULL project access). null/undefined → creator → unchanged today.
    await assertOwnerInTeam(teamId, input.ownerId ?? null);
    const effectiveOwnerId = input.ownerId ?? creatorId;
    if (input.accountableId !== undefined) {
      await assertAccountableInTeam(teamId, input.accountableId);
    }
    if (input.labelIds !== undefined) {
      await assertLabelsBelongToTeam(teamId, input.labelIds);
    }
    const planned = normaliseBudget(input.plannedBudget);
    const startDate = normalizeOptionalCalendarDate(input.startDate);
    const endDate = normalizeOptionalCalendarDate(input.endDate);
    assertDateRange(startDate ?? null, endDate ?? null);

    let budgetCurrency = input.budgetCurrency;
    if (budgetCurrency === undefined) {
      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { defaultCurrency: true },
      });
      budgetCurrency = team?.defaultCurrency ?? 'IRR';
    }

    // v1.98 (PMIS R2): resolve + snapshot the base profile (picker ▸ team
    // default ▸ system NEUTRAL) onto the new project so later re-publishing a
    // profile never silently mutates it. Backfills to NEUTRAL → identity.
    const baseProfile = await new ProfilesService().resolveBaseProfileForCreate(
      teamId,
      input.profileId ?? null,
    );

    try {
      const p = await prisma.project.create({
        data: {
          teamId,
          ownerId: effectiveOwnerId,
          accountableId: input.accountableId ?? null,
          name: input.name,
          ...(input.code !== undefined && { code: input.code }),
          description: input.description ?? null,
          ...(input.status !== undefined && { status: input.status }),
          budgetCurrency,
          ...(planned !== undefined && { plannedBudget: planned }),
          ...(startDate !== undefined && { startDate }),
          ...(endDate !== undefined && { endDate }),
          ...(baseProfile && {
            profileId: baseProfile.profileId,
            profileVersion: baseProfile.profileVersion,
          }),
        },
        include: projectInclude,
      });
      if (input.labelIds !== undefined && input.labelIds.length > 0) {
        await syncProjectLabels(p.id, input.labelIds);
        const hydrated = await prisma.project.findUniqueOrThrow({
          where: { id: p.id },
          include: projectInclude,
        });
        return toView(hydrated);
      }
      return toView(p);
    } catch (err) {
      rethrowProjectCodeConflict(err);
    }
  }

  async list(
    teamId: string,
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<ProjectView[]> {
    const where = await projectListWhereForCaller(teamId, callerUserId, callerGlobalRole);
    const rows = await prisma.project.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: projectInclude,
    });
    return rows.map(toView);
  }

  async get(
    teamId: string,
    projectId: string,
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<ProjectView> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      include: projectInclude,
    });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    if ((await resolveProjectAccess(projectId, teamId, callerUserId, callerGlobalRole, 'view')) === 'NONE') {
      throw Errors.notFound('Project not found');
    }
    return toView(p);
  }

  async update(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
    input: {
      name?: string;
      code?: string | null;
      description?: string | null;
      status?: ProjectStatus;
      ownerId?: string | null;
      accountableId?: string | null;
      plannedBudget?: number | string | null;
      budgetCurrency?: Currency;
      startDate?: string | null;
      endDate?: string | null;
      labelIds?: string[];
      // v2.5.58: plan freeze toggle — only the owner/admin full-edit path
      // reaches it (counted as a non-name field below).
      datesFrozen?: boolean;
    },
  ): Promise<ProjectView> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true, ownerId: true, startDate: true, endDate: true, datesFrozen: true },
    });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');

    const isOwner = p.ownerId === callerId;
    const isAdmin = callerGlobalRole === 'ADMIN';
    const canRenameOthers =
      !isOwner && !isAdmin && (await callerHasProjectEdit(teamId, callerId, callerGlobalRole));

    if (!isOwner && !isAdmin && !canRenameOthers) {
      throw Errors.notFound('Project not found');
    }
    if (canRenameOthers) {
      if (updateTouchesNonNameFields(input)) {
        throw Errors.forbidden('Managers may only rename projects they do not own');
      }
      if (input.name === undefined) {
        throw Errors.badRequest('Provide a name to rename this project');
      }
    }

    // v1.86: owner reassignment. Only the owner/admin full-edit path reaches
    // here with ownerId set (rename-only managers are rejected above). A new
    // owner must be a team member — never grant FULL access to an outsider.
    if (input.ownerId !== undefined) {
      await assertOwnerInTeam(teamId, input.ownerId);
    }
    if (input.accountableId !== undefined) {
      await assertAccountableInTeam(teamId, input.accountableId);
    }
    if (input.labelIds !== undefined) {
      await assertLabelsBelongToTeam(teamId, input.labelIds);
    }
    const plannedPatch = normaliseBudget(input.plannedBudget);
    const startPatch = normalizeOptionalCalendarDate(input.startDate);
    const endPatch = normalizeOptionalCalendarDate(input.endDate);
    const nextStart = startPatch !== undefined ? startPatch : p.startDate;
    const nextEnd = endPatch !== undefined ? endPatch : p.endDate;
    assertDateRange(nextStart, nextEnd);

    // v2.5.58: plan freeze. An unfreeze in the SAME request lifts the gate
    // (so the edit modal can unfreeze + fix dates in one save); a freeze in
    // the same request locks it immediately.
    const effectiveFrozen = input.datesFrozen ?? p.datesFrozen;
    if (effectiveFrozen && (startPatch !== undefined || endPatch !== undefined)) {
      throw Errors.datesFrozen();
    }

    try {
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.code !== undefined && { code: input.code }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
          ...(input.accountableId !== undefined && { accountableId: input.accountableId }),
          ...(plannedPatch !== undefined && { plannedBudget: plannedPatch }),
          ...(input.budgetCurrency !== undefined && { budgetCurrency: input.budgetCurrency }),
          ...(startPatch !== undefined && { startDate: startPatch }),
          ...(endPatch !== undefined && { endDate: endPatch }),
          ...(input.datesFrozen !== undefined && { datesFrozen: input.datesFrozen }),
        },
        include: projectInclude,
      });
      if (input.datesFrozen !== undefined && input.datesFrozen !== p.datesFrozen) {
        await logActivity(prisma, {
          teamId,
          actorId: callerId,
          action: input.datesFrozen ? 'project.dates_frozen' : 'project.dates_unfrozen',
          meta: { projectId },
        });
      }
      if (input.labelIds !== undefined) {
        await syncProjectLabels(projectId, input.labelIds);
        const hydrated = await prisma.project.findUniqueOrThrow({
          where: { id: projectId },
          include: projectInclude,
        });
        return toView(hydrated);
      }
      return toView(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Project not found');
      }
      rethrowProjectCodeConflict(err);
    }
  }

  // v1.91 (PMIS R1): set a project's health (RAG). Gated on project WRITE
  // access — owner, manager-write (project.write_all), or a FULL group grant —
  // the same authority that edits a project's tasks. Non-writers get the
  // existence-hiding 404/403 from assertProjectWrite. Stamps healthUpdatedAt so
  // the portfolio view can surface stale health.
  async setHealth(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
    input: { ragStatus: RagStatus; ragReason?: string | null },
  ): Promise<ProjectView> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    await assertProjectWrite(projectId, teamId, callerId, callerGlobalRole);
    const updated = await prisma.project.update({
      where: { id: projectId },
      data: {
        ragStatus: input.ragStatus,
        ...(input.ragReason !== undefined && { ragReason: input.ragReason }),
        healthUpdatedAt: new Date(),
      },
      include: projectInclude,
    });
    return toView(updated);
  }

  async remove(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true, ownerId: true },
    });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    if (callerGlobalRole !== 'ADMIN' && p.ownerId !== callerId) {
      throw Errors.notFound('Project not found');
    }
    await prisma.userProjectBucketItem.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
  }

  async listAllVisible(
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<
    Array<
      ProjectView & {
        teamName: string;
        teamSlug: string;
        hasStarted: boolean;
        progressPct: number;
      }
    >
  > {
    const where = await projectListAllWhereForCaller(callerUserId, callerGlobalRole);
    const rows = await prisma.project.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        ...projectInclude,
        team: { select: { name: true, slug: true } },
      },
    });
    // v2.5.58: "has this project actually started?" for the year-timeline
    // page — one indexed groupBy instead of loading task rows. Started = any
    // live task past TODO, or with a recorded actual start.
    const startedGroups = rows.length
      ? await prisma.task.groupBy({
          by: ['projectId'],
          where: {
            projectId: { in: rows.map((p) => p.id) },
            deletedAt: null,
            OR: [{ status: { not: 'TODO' } }, { actualStart: { not: null } }],
          },
          _count: { _all: true },
        })
      : [];
    const startedIds = new Set(startedGroups.map((g) => g.projectId));
    // v2.5.59: project progress for the year-timeline's green fill. Mean
    // percentComplete over LIVE LEAF tasks — the same earned-value definition
    // evmService uses, so the two never disagree. Summary rows are excluded
    // because their percentComplete is a rollup of the leaves beneath them and
    // would double-count. Tasks whose progress is driven by their subtasks
    // already reflect that here via PercentCompleteMode.FROM_CHILDREN.
    // One indexed groupBy for the whole page, mirroring `hasStarted` above.
    const progressGroups = rows.length
      ? await prisma.task.groupBy({
          by: ['projectId'],
          where: {
            projectId: { in: rows.map((p) => p.id) },
            deletedAt: null,
            isSummary: false,
          },
          _avg: { percentComplete: true },
        })
      : [];
    const progressById = new Map(
      progressGroups.map((g) => [g.projectId, Math.round(g._avg.percentComplete ?? 0)]),
    );
    return rows.map((p) => ({
      ...toView(p),
      teamName: p.team.name,
      teamSlug: p.team.slug,
      hasStarted: startedIds.has(p.id),
      // Projects with no live leaf tasks have no evidence of progress → 0.
      progressPct: progressById.get(p.id) ?? 0,
    }));
  }

  // v2.5.58: whole-team shares (ProjectTeamShare) — global-ADMIN managed.
  // The route layer enforces the ADMIN gate; these methods validate shape.
  async listTeamShares(
    teamId: string,
    projectId: string,
  ): Promise<Array<{ teamId: string; teamName: string; teamSlug: string; level: 'FULL' | 'READONLY'; createdAt: Date }>> {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { teamId: true } });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    const rows = await prisma.projectTeamShare.findMany({
      where: { projectId },
      include: { team: { select: { name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      teamId: r.teamId,
      teamName: r.team.name,
      teamSlug: r.team.slug,
      level: r.level,
      createdAt: r.createdAt,
    }));
  }

  async setTeamShares(
    teamId: string,
    projectId: string,
    actorId: string,
    shares: Array<{ teamId: string; level: 'FULL' | 'READONLY' }>,
  ): Promise<Array<{ teamId: string; teamName: string; teamSlug: string; level: 'FULL' | 'READONLY'; createdAt: Date }>> {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { teamId: true } });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');

    const guestIds = shares.map((s) => s.teamId);
    if (new Set(guestIds).size !== guestIds.length) {
      throw Errors.badRequest('Duplicate team in shares');
    }
    if (guestIds.includes(teamId)) {
      throw Errors.badRequest('Cannot share a project with its own team');
    }
    if (guestIds.length > 0) {
      const found = await prisma.team.count({ where: { id: { in: guestIds } } });
      if (found !== guestIds.length) throw Errors.badRequest('Unknown team in shares');
    }

    // Replace-set in one tx, mirroring group grants / edit delegates.
    await prisma.$transaction(async (tx) => {
      await tx.projectTeamShare.deleteMany({ where: { projectId } });
      if (shares.length > 0) {
        await tx.projectTeamShare.createMany({
          data: shares.map((s) => ({
            projectId,
            teamId: s.teamId,
            level: s.level,
            createdById: actorId,
          })),
        });
      }
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'project.team_shares_updated',
        meta: { projectId, shares: shares.map((s) => ({ teamId: s.teamId, level: s.level })) },
      });
    });
    return this.listTeamShares(teamId, projectId);
  }

  async assertCallerCanAccess(
    teamId: string,
    projectId: string,
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    const access = await resolveProjectAccess(
      projectId,
      teamId,
      callerUserId,
      callerGlobalRole,
      'nested',
    );
    if (access === 'NONE') throw Errors.notFound('Project not found');
  }

  async assertCanWriteProject(
    teamId: string,
    projectId: string,
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    await assertProjectWrite(projectId, teamId, callerUserId, callerGlobalRole);
  }

  // v1.86: per-project full-edit delegation management. Only the project OWNER
  // or a global ADMIN may view/modify the delegate set — same authority that
  // controls ownership. Non-owners get a 404 (existence hidden), matching
  // remove()/update().
  private async assertOwnerOrAdmin(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true, ownerId: true },
    });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    if (callerGlobalRole !== 'ADMIN' && p.ownerId !== callerId) {
      throw Errors.notFound('Project not found');
    }
  }

  async listDelegates(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<{ userId: string; capabilities: string[] }[]> {
    await this.assertOwnerOrAdmin(teamId, projectId, callerId, callerGlobalRole);
    const rows = await prisma.projectEditDelegate.findMany({
      where: { projectId },
      select: { userId: true, capabilities: true },
    });
    return rows.map((r) => ({ userId: r.userId, capabilities: r.capabilities }));
  }

  // Self-scoped: the caller's effective delegate capabilities on this project.
  // Readable by any team member (the route's requireTeamRole gate) — returns
  // only the caller's own set, so it leaks nothing about the rest.
  async myDelegateCapabilities(
    teamId: string,
    projectId: string,
    userId: string,
  ): Promise<string[]> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    return [...(await getDelegateCapabilities(projectId, userId))];
  }

  // Replace-set semantics. Every delegate must be a team member — delegation is
  // a real elevation, never granted to an outsider. Each entry's capabilities
  // are validated to the known set by the route's Zod body.
  async setDelegates(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
    delegates: { userId: string; capabilities: string[] }[],
  ): Promise<{ userId: string; capabilities: string[] }[]> {
    await this.assertOwnerOrAdmin(teamId, projectId, callerId, callerGlobalRole);
    // Dedupe by userId (last wins); drop entries with no capabilities.
    const byUser = new Map<string, string[]>();
    for (const d of delegates) {
      if (d.capabilities.length > 0) byUser.set(d.userId, [...new Set(d.capabilities)]);
    }
    const userIds = [...byUser.keys()];
    if (userIds.length > 0) {
      const count = await prisma.teamMembership.count({
        where: { teamId, userId: { in: userIds } },
      });
      if (count !== userIds.length) {
        throw Errors.badRequest('Every delegate must be a member of this team');
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.projectEditDelegate.deleteMany({
        where: {
          projectId,
          ...(userIds.length > 0 ? { userId: { notIn: userIds } } : {}),
        },
      });
      for (const [userId, capabilities] of byUser) {
        await tx.projectEditDelegate.upsert({
          where: { projectId_userId: { projectId, userId } },
          create: { projectId, userId, grantedById: callerId, capabilities },
          update: { capabilities, grantedById: callerId },
        });
      }
    });
    return [...byUser].map(([userId, capabilities]) => ({ userId, capabilities }));
  }
}

export {
  resolveProjectAccess,
  assertCanWriteProject,
} from '../lib/projectAccess.js';
