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
import { listMembershipPermissions } from '../middleware/requirePermission.js';
// Project visibility (additive):
// - globalRole === 'ADMIN' → all projects
// - owner → own project (full edit + nested routes)
// - project.edit manager → see all team projects; rename others (name only)
// - group grant → see + nested routes (owner-equivalent for tasks/…)
// - everyone else → own projects only

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
  actualSpent: string | null;
  budgetCurrency: Currency;
  startDate: string | null;
  endDate: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function normaliseBudget(v: number | string | null | undefined): Prisma.Decimal | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (s.length === 0) return null;
  return new Prisma.Decimal(s);
}

function toView(
  p: Awaited<ReturnType<typeof prisma.project.findFirstOrThrow>> & {
    accountable?: { name: string } | null;
  },
): ProjectView {
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
    actualSpent: p.actualSpent === null ? null : p.actualSpent.toFixed(2),
    budgetCurrency: p.budgetCurrency,
    startDate: calendarDateToIso(p.startDate),
    endDate: calendarDateToIso(p.endDate),
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
  accountableId?: string | null;
  plannedBudget?: number | string | null;
  actualSpent?: number | string | null;
  budgetCurrency?: Currency;
  startDate?: string | null;
  endDate?: string | null;
}): boolean {
  return (
    input.description !== undefined
    || input.status !== undefined
    || input.accountableId !== undefined
    || input.plannedBudget !== undefined
    || input.actualSpent !== undefined
    || input.budgetCurrency !== undefined
    || input.startDate !== undefined
    || input.endDate !== undefined
  );
}

export class ProjectsService {
  async create(
    teamId: string,
    ownerId: string,
    input: {
      name: string;
      description?: string;
      status?: ProjectStatus;
      accountableId?: string | null;
      plannedBudget?: number | string | null;
      actualSpent?: number | string | null;
      budgetCurrency?: Currency;
      startDate?: string | null;
      endDate?: string | null;
    },
  ): Promise<ProjectView> {
    if (input.accountableId !== undefined) {
      await assertAccountableInTeam(teamId, input.accountableId);
    }
    const planned = normaliseBudget(input.plannedBudget);
    const spent = normaliseBudget(input.actualSpent);
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
        ownerId,
        accountableId: input.accountableId ?? null,
        name: input.name,
        description: input.description ?? null,
        ...(input.status !== undefined && { status: input.status }),
        budgetCurrency,
        ...(planned !== undefined && { plannedBudget: planned }),
        ...(spent !== undefined && { actualSpent: spent }),
        ...(startDate !== undefined && { startDate }),
        ...(endDate !== undefined && { endDate }),
      },
      include: { accountable: { select: { name: true } } },
    });
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
      include: { accountable: { select: { name: true } } },
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
      include: { accountable: { select: { name: true } } },
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
      accountableId?: string | null;
      plannedBudget?: number | string | null;
      actualSpent?: number | string | null;
      budgetCurrency?: Currency;
      startDate?: string | null;
      endDate?: string | null;
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

    if (input.accountableId !== undefined) {
      await assertAccountableInTeam(teamId, input.accountableId);
    }
    const plannedPatch = normaliseBudget(input.plannedBudget);
    const spentPatch = normaliseBudget(input.actualSpent);
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
          ...(input.accountableId !== undefined && { accountableId: input.accountableId }),
          ...(plannedPatch !== undefined && { plannedBudget: plannedPatch }),
          ...(spentPatch !== undefined && { actualSpent: spentPatch }),
          ...(input.budgetCurrency !== undefined && { budgetCurrency: input.budgetCurrency }),
          ...(startPatch !== undefined && { startDate: startPatch }),
          ...(endPatch !== undefined && { endDate: endPatch }),
        },
        include: { accountable: { select: { name: true } } },
      });
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
        accountable: { select: { name: true } },
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
}

export {
  resolveProjectAccess,
  assertCanWriteProject,
} from '../lib/projectAccess.js';
