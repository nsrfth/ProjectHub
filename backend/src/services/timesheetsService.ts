import { type Currency, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { formatMinor } from '../lib/money.js';
import { convertMinor } from '../lib/fx.js';
import { logActivity } from './activityLogger.js';
import { ProfilesService } from './profilesService.js';
import { ensureDefaultCostAccount, reportingCurrencyFor } from './costService.js';
import type {
  CreateRateCardBody,
  CreateTimeEntryBody,
  EnsurePeriodBody,
  UpdateRateCardBody,
  UpdateTimeEntryBody,
} from '../schemas/timesheets.js';

function asDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function toMinorBig(v: string | number): bigint {
  return BigInt(typeof v === 'number' ? Math.trunc(v) : v);
}
// minutes * ratePerHourMinor / 60, rounded half-up (non-negative inputs).
function labourCostMinor(minutes: number, ratePerHourMinor: bigint): bigint {
  const total = BigInt(minutes) * ratePerHourMinor;
  return (total + 30n) / 60n;
}

const EDITABLE: ReadonlyArray<string> = ['OPEN', 'REOPENED'];

export class TimesheetsService {
  private readonly profiles = new ProfilesService();

  // ---- Rate cards (team admin) -------------------------------------------
  async listRateCards(teamId: string) {
    const rows = await prisma.rateCard.findMany({
      where: { teamId },
      include: { user: { select: { name: true } } },
      orderBy: [{ effectiveFrom: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      userId: r.userId,
      userName: r.user?.name ?? null,
      role: r.role,
      currency: r.currency,
      costRateMinor: r.costRateMinor.toString(),
      costRate: formatMinor(r.costRateMinor, r.currency),
      billRateMinor: r.billRateMinor === null ? null : r.billRateMinor.toString(),
      billRate: r.billRateMinor === null ? null : formatMinor(r.billRateMinor, r.currency),
      effectiveFrom: dayString(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? dayString(r.effectiveTo) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createRateCard(teamId: string, actorId: string, body: CreateRateCardBody) {
    if (body.scope === 'USER' && body.userId) {
      const m = await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId: body.userId, teamId } },
        select: { userId: true },
      });
      if (!m) throw Errors.notFound('User is not a member of this team');
    }
    const created = await prisma.rateCard.create({
      data: {
        teamId,
        scope: body.scope,
        userId: body.scope === 'USER' ? body.userId ?? null : null,
        role: body.scope === 'ROLE' ? (body.role as TeamRole) ?? null : null,
        currency: body.currency,
        costRateMinor: toMinorBig(body.costRateMinor),
        billRateMinor: body.billRateMinor === undefined ? null : toMinorBig(body.billRateMinor),
        effectiveFrom: asDate(body.effectiveFrom),
        effectiveTo: body.effectiveTo ? asDate(body.effectiveTo) : null,
      },
    });
    await logActivity(prisma, {
      teamId,
      actorId,
      action: 'rate_card.created',
      meta: { rateCardId: created.id, scope: created.scope },
    });
    return (await this.listRateCards(teamId)).find((r) => r.id === created.id)!;
  }

  async updateRateCard(teamId: string, id: string, actorId: string, body: UpdateRateCardBody) {
    const existing = await prisma.rateCard.findFirst({ where: { id, teamId }, select: { id: true } });
    if (!existing) throw Errors.notFound('Rate card not found');
    await prisma.rateCard.update({
      where: { id },
      data: {
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.costRateMinor !== undefined && { costRateMinor: toMinorBig(body.costRateMinor) }),
        ...(body.billRateMinor !== undefined && {
          billRateMinor: body.billRateMinor === null ? null : toMinorBig(body.billRateMinor),
        }),
        ...(body.effectiveFrom !== undefined && { effectiveFrom: asDate(body.effectiveFrom) }),
        ...(body.effectiveTo !== undefined && {
          effectiveTo: body.effectiveTo === null ? null : asDate(body.effectiveTo),
        }),
      },
    });
    await logActivity(prisma, { teamId, actorId, action: 'rate_card.updated', meta: { rateCardId: id } });
    return (await this.listRateCards(teamId)).find((r) => r.id === id)!;
  }

  async deleteRateCard(teamId: string, id: string, actorId: string): Promise<void> {
    const existing = await prisma.rateCard.findFirst({ where: { id, teamId }, select: { id: true } });
    if (!existing) throw Errors.notFound('Rate card not found');
    await prisma.rateCard.delete({ where: { id } });
    await logActivity(prisma, { teamId, actorId, action: 'rate_card.deleted', meta: { rateCardId: id } });
  }

  // Resolve the cost rate in force for a user on a date: USER-scope wins over
  // ROLE-scope; within a scope the latest effectiveFrom ≤ date that hasn't ended.
  private async resolveRate(
    teamId: string,
    userId: string,
    date: Date,
  ): Promise<{ costRateMinor: bigint; currency: Currency } | null> {
    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { role: true },
    });
    const candidates = await prisma.rateCard.findMany({
      where: {
        teamId,
        effectiveFrom: { lte: date },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
        AND: [
          {
            OR: [
              { scope: 'USER', userId },
              ...(membership ? [{ scope: 'ROLE' as const, role: membership.role }] : []),
            ],
          },
        ],
      },
      orderBy: [{ effectiveFrom: 'desc' }],
    });
    const userScoped = candidates.find((c) => c.scope === 'USER');
    const pick = userScoped ?? candidates.find((c) => c.scope === 'ROLE');
    if (!pick) return null;
    return { costRateMinor: pick.costRateMinor, currency: pick.currency };
  }

  // ---- Time entries -------------------------------------------------------
  private async assertProjectInTeam(teamId: string, projectId: string): Promise<void> {
    const p = await prisma.project.findFirst({ where: { id: projectId, teamId }, select: { id: true } });
    if (!p) throw Errors.notFound('Project not found');
  }

  private periodStatusOf(period: { status: string } | null): string {
    return period?.status ?? 'OPEN';
  }

  async listTimeEntries(
    teamId: string,
    filter: { userId?: string; projectId?: string; from?: string; to?: string },
  ) {
    const rows = await prisma.timeEntry.findMany({
      where: {
        teamId,
        ...(filter.userId && { userId: filter.userId }),
        ...(filter.projectId && { projectId: filter.projectId }),
        ...(filter.from || filter.to
          ? {
              date: {
                ...(filter.from && { gte: asDate(filter.from) }),
                ...(filter.to && { lte: asDate(filter.to) }),
              },
            }
          : {}),
      },
      include: {
        user: { select: { name: true } },
        project: { select: { name: true } },
        task: { select: { title: true } },
        period: { select: { status: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => this.toEntryView(r));
  }

  private toEntryView(r: {
    id: string;
    userId: string;
    projectId: string;
    taskId: string | null;
    periodId: string | null;
    date: Date;
    minutes: number;
    billable: boolean;
    note: string | null;
    costRateMinorSnapshot: bigint | null;
    currencySnapshot: Currency | null;
    createdAt: Date;
    user?: { name: string } | null;
    project?: { name: string } | null;
    task?: { title: string } | null;
    period?: { status: string } | null;
  }) {
    return {
      id: r.id,
      userId: r.userId,
      userName: r.user?.name ?? null,
      projectId: r.projectId,
      projectName: r.project?.name ?? null,
      taskId: r.taskId,
      taskTitle: r.task?.title ?? null,
      periodId: r.periodId,
      status: this.periodStatusOf(r.period ?? null) as
        | 'OPEN'
        | 'SUBMITTED'
        | 'APPROVED'
        | 'REJECTED'
        | 'REOPENED',
      date: dayString(r.date),
      minutes: r.minutes,
      hours: (r.minutes / 60).toFixed(2),
      billable: r.billable,
      note: r.note,
      costRateMinorSnapshot: r.costRateMinorSnapshot === null ? null : r.costRateMinorSnapshot.toString(),
      currencySnapshot: r.currencySnapshot,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async createOne(teamId: string, userId: string, body: CreateTimeEntryBody) {
    await this.assertProjectInTeam(teamId, body.projectId);
    // Profile module gate (timesheets routes are team-scoped, so requireModule —
    // which needs :projectId on the path — can't run; enforce per-entry here).
    const enabled = await this.profiles.isModuleEnabled(teamId, body.projectId, 'timesheets');
    if (!enabled) throw Errors.moduleDisabled('timesheets');
    const date = asDate(body.date);
    if (body.taskId) {
      const t = await prisma.task.findFirst({
        where: { id: body.taskId, projectId: body.projectId },
        select: { id: true },
      });
      if (!t) throw Errors.badRequest('Task does not belong to the project');
    }
    // Find an editable period covering this date (created via ensurePeriod).
    const period = await prisma.timesheetPeriod.findFirst({
      where: { teamId, userId, periodStart: { lte: date }, periodEnd: { gte: date } },
      select: { id: true, status: true },
    });
    if (period && !EDITABLE.includes(period.status)) {
      throw Errors.conflict('Timesheet period is locked; reopen it to edit entries');
    }
    const rate = await this.resolveRate(teamId, userId, date);
    return prisma.timeEntry.create({
      data: {
        teamId,
        userId,
        projectId: body.projectId,
        taskId: body.taskId ?? null,
        periodId: period?.id ?? null,
        date,
        minutes: body.minutes,
        billable: body.billable ?? true,
        note: body.note ?? null,
        costRateMinorSnapshot: rate?.costRateMinor ?? null,
        currencySnapshot: rate?.currency ?? null,
      },
    });
  }

  async createTimeEntry(teamId: string, userId: string, body: CreateTimeEntryBody) {
    const created = await this.createOne(teamId, userId, body);
    const full = await prisma.timeEntry.findUnique({
      where: { id: created.id },
      include: {
        user: { select: { name: true } },
        project: { select: { name: true } },
        task: { select: { title: true } },
        period: { select: { status: true } },
      },
    });
    return this.toEntryView(full!);
  }

  async bulkCreate(teamId: string, userId: string, entries: CreateTimeEntryBody[]) {
    const out = [];
    for (const e of entries) out.push(await this.createTimeEntry(teamId, userId, e));
    return out;
  }

  async updateTimeEntry(teamId: string, id: string, actorId: string, body: UpdateTimeEntryBody) {
    const entry = await prisma.timeEntry.findFirst({
      where: { id, teamId },
      include: { period: { select: { status: true } } },
    });
    if (!entry) throw Errors.notFound('Time entry not found');
    if (entry.userId !== actorId) throw Errors.forbidden('You can only edit your own time entries');
    if (entry.period && !EDITABLE.includes(entry.period.status)) {
      throw Errors.conflict('Timesheet period is locked; reopen it to edit entries');
    }
    const nextDate = body.date ? asDate(body.date) : entry.date;
    let rateUpdate: { costRateMinorSnapshot: bigint | null; currencySnapshot: Currency | null } | undefined;
    if (body.date) {
      const rate = await this.resolveRate(teamId, entry.userId, nextDate);
      rateUpdate = { costRateMinorSnapshot: rate?.costRateMinor ?? null, currencySnapshot: rate?.currency ?? null };
    }
    await prisma.timeEntry.update({
      where: { id },
      data: {
        ...(body.taskId !== undefined && { taskId: body.taskId }),
        ...(body.date !== undefined && { date: nextDate }),
        ...(body.minutes !== undefined && { minutes: body.minutes }),
        ...(body.billable !== undefined && { billable: body.billable }),
        ...(body.note !== undefined && { note: body.note }),
        ...(rateUpdate ?? {}),
      },
    });
    const full = await prisma.timeEntry.findUnique({
      where: { id },
      include: {
        user: { select: { name: true } },
        project: { select: { name: true } },
        task: { select: { title: true } },
        period: { select: { status: true } },
      },
    });
    return this.toEntryView(full!);
  }

  async deleteTimeEntry(teamId: string, id: string, actorId: string): Promise<void> {
    const entry = await prisma.timeEntry.findFirst({
      where: { id, teamId },
      include: { period: { select: { status: true } } },
    });
    if (!entry) throw Errors.notFound('Time entry not found');
    if (entry.userId !== actorId) throw Errors.forbidden('You can only delete your own time entries');
    if (entry.period && !EDITABLE.includes(entry.period.status)) {
      throw Errors.conflict('Timesheet period is locked; reopen it to edit entries');
    }
    await prisma.timeEntry.delete({ where: { id } });
  }

  // ---- Timesheet periods --------------------------------------------------
  async listPeriods(teamId: string, filter: { userId?: string }) {
    const rows = await prisma.timesheetPeriod.findMany({
      where: { teamId, ...(filter.userId && { userId: filter.userId }) },
      include: {
        user: { select: { name: true } },
        entries: { select: { minutes: true } },
      },
      orderBy: [{ periodStart: 'desc' }],
    });
    return rows.map((p) => this.toPeriodView(p));
  }

  private toPeriodView(p: {
    id: string;
    userId: string;
    periodStart: Date;
    periodEnd: Date;
    status: string;
    submittedAt: Date | null;
    decidedAt: Date | null;
    rejectionReason: string | null;
    createdAt: Date;
    user?: { name: string } | null;
    entries: { minutes: number }[];
  }) {
    return {
      id: p.id,
      userId: p.userId,
      userName: p.user?.name ?? null,
      periodStart: dayString(p.periodStart),
      periodEnd: dayString(p.periodEnd),
      status: p.status as 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'REOPENED',
      submittedAt: p.submittedAt ? p.submittedAt.toISOString() : null,
      decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null,
      rejectionReason: p.rejectionReason,
      totalMinutes: p.entries.reduce((s, e) => s + e.minutes, 0),
      entryCount: p.entries.length,
      createdAt: p.createdAt.toISOString(),
    };
  }

  async ensurePeriod(teamId: string, userId: string, body: EnsurePeriodBody) {
    const start = asDate(body.periodStart);
    const end = asDate(body.periodEnd);
    if (end < start) throw Errors.badRequest('periodEnd must be on or after periodStart');
    const existing = await prisma.timesheetPeriod.findUnique({
      where: { userId_periodStart: { userId, periodStart: start } },
      select: { id: true },
    });
    const period =
      existing ??
      (await prisma.timesheetPeriod.create({
        data: { teamId, userId, periodStart: start, periodEnd: end, status: 'OPEN' },
        select: { id: true },
      }));
    // Adopt any orphan entries that fall in the window.
    await prisma.timeEntry.updateMany({
      where: { teamId, userId, periodId: null, date: { gte: start, lte: end } },
      data: { periodId: period.id },
    });
    return this.getPeriod(teamId, period.id);
  }

  private async getPeriod(teamId: string, id: string) {
    const p = await prisma.timesheetPeriod.findFirst({
      where: { id, teamId },
      include: { user: { select: { name: true } }, entries: { select: { minutes: true } } },
    });
    if (!p) throw Errors.notFound('Timesheet period not found');
    return this.toPeriodView(p);
  }

  async submitPeriod(teamId: string, id: string, actorId: string) {
    const p = await prisma.timesheetPeriod.findFirst({ where: { id, teamId } });
    if (!p) throw Errors.notFound('Timesheet period not found');
    if (p.userId !== actorId) throw Errors.forbidden('You can only submit your own timesheet');
    if (!['OPEN', 'REOPENED'].includes(p.status)) {
      throw Errors.conflict(`Cannot submit a timesheet in ${p.status}`);
    }
    await prisma.timesheetPeriod.update({
      where: { id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
    await logActivity(prisma, { teamId, actorId, action: 'timesheet.submitted', meta: { periodId: id } });
    return this.getPeriod(teamId, id);
  }

  async approvePeriod(teamId: string, id: string, actorId: string) {
    const p = await prisma.timesheetPeriod.findFirst({ where: { id, teamId } });
    if (!p) throw Errors.notFound('Timesheet period not found');
    if (p.status !== 'SUBMITTED') throw Errors.conflict(`Cannot approve a timesheet in ${p.status}`);

    const reportingCurrency = await reportingCurrencyFor(teamId);
    await prisma.$transaction(async (tx) => {
      await tx.timesheetPeriod.update({
        where: { id },
        data: { status: 'APPROVED', decidedAt: new Date(), decidedById: actorId, rejectionReason: null },
      });
      const entries = await tx.timeEntry.findMany({
        where: { periodId: id, costRateMinorSnapshot: { not: null } },
      });
      const byProject = new Map<string, string>(); // projectId -> default cost account id
      for (const e of entries) {
        if (!e.currencySnapshot || e.costRateMinorSnapshot === null) continue;
        const amount = labourCostMinor(e.minutes, e.costRateMinorSnapshot);
        if (amount === 0n) continue;
        let accountId = byProject.get(e.projectId);
        if (!accountId) {
          accountId = await ensureDefaultCostAccount(tx, teamId, e.projectId);
          byProject.set(e.projectId, accountId);
        }
        const fx = await convertMinor(tx, amount, e.currencySnapshot, reportingCurrency, e.date);
        await tx.actualCostEntry.create({
          data: {
            teamId,
            projectId: e.projectId,
            costAccountId: accountId,
            taskId: e.taskId,
            source: 'TIMESHEET',
            amountMinor: amount,
            currency: e.currencySnapshot,
            baseAmountMinor: fx.baseAmountMinor,
            baseCurrency: reportingCurrency,
            fxRateId: fx.fxRateId,
            incurredOn: e.date,
            description: 'Labour (timesheet)',
            sourceTimeEntryId: e.id,
            createdById: actorId,
          },
        });
      }
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'timesheet.approved',
        meta: { periodId: id, postedEntries: entries.length },
      });
    });
    return this.getPeriod(teamId, id);
  }

  async rejectPeriod(teamId: string, id: string, actorId: string, reason: string) {
    const p = await prisma.timesheetPeriod.findFirst({ where: { id, teamId } });
    if (!p) throw Errors.notFound('Timesheet period not found');
    if (p.status !== 'SUBMITTED') throw Errors.conflict(`Cannot reject a timesheet in ${p.status}`);
    await prisma.timesheetPeriod.update({
      where: { id },
      data: { status: 'REJECTED', decidedAt: new Date(), decidedById: actorId, rejectionReason: reason },
    });
    await logActivity(prisma, { teamId, actorId, action: 'timesheet.rejected', meta: { periodId: id } });
    return this.getPeriod(teamId, id);
  }

  // Reopen for edits. From APPROVED we reverse the posted labour actuals (the
  // ledger is append-only → post negating rows) so a re-approve posts cleanly.
  async reopenPeriod(teamId: string, id: string, actorId: string) {
    const p = await prisma.timesheetPeriod.findFirst({ where: { id, teamId } });
    if (!p) throw Errors.notFound('Timesheet period not found');
    if (!['APPROVED', 'REJECTED'].includes(p.status)) {
      throw Errors.conflict(`Cannot reopen a timesheet in ${p.status}`);
    }
    await prisma.$transaction(async (tx) => {
      if (p.status === 'APPROVED') {
        const entryIds = (
          await tx.timeEntry.findMany({ where: { periodId: id }, select: { id: true } })
        ).map((e) => e.id);
        const posted = await tx.actualCostEntry.findMany({
          where: { sourceTimeEntryId: { in: entryIds }, reversalOfId: null },
        });
        for (const a of posted) {
          // Skip if already reversed.
          const already = await tx.actualCostEntry.findFirst({ where: { reversalOfId: a.id }, select: { id: true } });
          if (already) continue;
          await tx.actualCostEntry.create({
            data: {
              teamId: a.teamId,
              projectId: a.projectId,
              costAccountId: a.costAccountId,
              taskId: a.taskId,
              source: a.source,
              amountMinor: -a.amountMinor,
              currency: a.currency,
              baseAmountMinor: -a.baseAmountMinor,
              baseCurrency: a.baseCurrency,
              fxRateId: a.fxRateId,
              incurredOn: a.incurredOn,
              description: 'Reversal (timesheet reopened)',
              reversalOfId: a.id,
              sourceTimeEntryId: a.sourceTimeEntryId,
              createdById: actorId,
            },
          });
        }
      }
      await tx.timesheetPeriod.update({
        where: { id },
        data: { status: 'REOPENED', submittedAt: null, decidedAt: null, decidedById: null },
      });
      await logActivity(tx, { teamId, actorId, action: 'timesheet.reopened', meta: { periodId: id } });
    });
    return this.getPeriod(teamId, id);
  }
}
