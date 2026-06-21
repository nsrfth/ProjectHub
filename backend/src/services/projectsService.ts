import { Prisma, type Currency, type GlobalRole, type ProjectStatus } from '@prisma/client';
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
import { listMembershipPermissions } from '../middleware/requirePermission.js';
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
  description: string | null;
  status: ProjectStatus;
  plannedBudget: string | null;
  budgetCurrency: Currency;
  startDate: string | null;
  endDate: string | null;
  labels: ProjectLabelView[];
  createdAt: Date;
  updatedAt: Date;
}

const projectInclude = {
  accountable: { select: { name: true } },
  labels: {
    include: { label: true },
    orderBy: { label: { name: 'asc' as const } },
  },
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
    description: p.description,
    status: p.status,
    plannedBudget: p.plannedBudget === null ? null : p.plannedBudget.toFixed(2),
    budgetCurrency: p.budgetCurrency,
    startDate: calendarDateToIso(p.startDate),
    endDate: calendarDateToIso(p.endDate),
    labels: mapLabels(p),
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
  description?: string | null;
  status?: ProjectStatus;
  ownerId?: string | null;
  accountableId?: string | null;
  plannedBudget?: number | string | null;
  budgetCurrency?: Currency;
  startDate?: string | null;
  endDate?: string | null;
  labelIds?: string[];
}): boolean {
  return (
    input.description !== undefined
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
  );
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
      description?: string;
      status?: ProjectStatus;
      ownerId?: string | null;
      accountableId?: string | null;
      plannedBudget?: number | string | null;
      budgetCurrency?: Currency;
      startDate?: string | null;
      endDate?: string | null;
      labelIds?: string[];
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
    const p = await prisma.project.create({
      data: {
        teamId,
        ownerId: effectiveOwnerId,
        accountableId: input.accountableId ?? null,
        name: input.name,
        description: input.description ?? null,
        ...(input.status !== undefined && { status: input.status }),
        budgetCurrency,
        ...(planned !== undefined && { plannedBudget: planned }),
        ...(startDate !== undefined && { startDate }),
        ...(endDate !== undefined && { endDate }),
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
      description?: string | null;
      status?: ProjectStatus;
      ownerId?: string | null;
      accountableId?: string | null;
      plannedBudget?: number | string | null;
      budgetCurrency?: Currency;
      startDate?: string | null;
      endDate?: string | null;
      labelIds?: string[];
    },
  ): Promise<ProjectView> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true, ownerId: true, startDate: true, endDate: true },
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

    try {
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
          ...(input.accountableId !== undefined && { accountableId: input.accountableId }),
          ...(plannedPatch !== undefined && { plannedBudget: plannedPatch }),
          ...(input.budgetCurrency !== undefined && { budgetCurrency: input.budgetCurrency }),
          ...(startPatch !== undefined && { startDate: startPatch }),
          ...(endPatch !== undefined && { endDate: endPatch }),
        },
        include: projectInclude,
      });
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
      throw err;
    }
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
  ): Promise<Array<ProjectView & { teamName: string; teamSlug: string }>> {
    const where = await projectListAllWhereForCaller(callerUserId, callerGlobalRole);
    const rows = await prisma.project.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        ...projectInclude,
        team: { select: { name: true, slug: true } },
      },
    });
    return rows.map((p) => ({
      ...toView(p),
      teamName: p.team.name,
      teamSlug: p.team.slug,
    }));
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
