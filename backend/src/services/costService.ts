import { Prisma, type Currency } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { formatMinor } from '../lib/money.js';
import { convertMinor } from '../lib/fx.js';
import { logActivity } from './activityLogger.js';
import type {
  CreateActualCostBody,
  CreateBudgetLineBody,
  CreateCommitmentBody,
  CreateCostAccountBody,
  CreateExpenseBody,
  CreateFxRateBody,
  UpdateCostAccountBody,
} from '../schemas/cost.js';

function asDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function toMinorBig(v: string | number): bigint {
  return BigInt(typeof v === 'number' ? Math.trunc(v) : v);
}

// Team reporting currency for base-currency roll-up. Falls back to the team's
// default project currency when reportingCurrency is unset (R0 left it nullable).
export async function reportingCurrencyFor(teamId: string): Promise<Currency> {
  const t = await prisma.team.findUnique({
    where: { id: teamId },
    select: { reportingCurrency: true, defaultCurrency: true },
  });
  return t?.reportingCurrency ?? t?.defaultCurrency ?? 'IRR';
}

// Find (or create) the project's DEFAULT cost account. Used by the migration,
// the timesheet approval posting path, and any cost mutation that omits an
// explicit account. `client` may be a transaction.
export async function ensureDefaultCostAccount(
  client: Prisma.TransactionClient | typeof prisma,
  teamId: string,
  projectId: string,
): Promise<string> {
  const existing = await client.costAccount.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await client.costAccount.create({
    data: { teamId, projectId, code: 'DEFAULT', name: 'Default', path: 'pending', isDefault: true },
    select: { id: true },
  });
  await client.costAccount.update({ where: { id: created.id }, data: { path: `/${created.id}` } });
  return created.id;
}

export class CostService {
  private async assertProject(teamId: string, projectId: string) {
    const p = await prisma.project.findFirst({
      where: { id: projectId, teamId },
      select: { id: true, budgetCurrency: true },
    });
    if (!p) throw Errors.notFound('Project not found');
    return p;
  }

  // ---- Cost accounts (CBS tree) ------------------------------------------
  async listCostAccounts(teamId: string, projectId: string) {
    await this.assertProject(teamId, projectId);
    const rows = await prisma.costAccount.findMany({
      where: { projectId },
      include: { _count: { select: { children: true, budgetLines: true } } },
      orderBy: [{ path: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      parentId: r.parentId,
      code: r.code,
      name: r.name,
      path: r.path,
      isDefault: r.isDefault,
      childCount: r._count.children,
      budgetLineCount: r._count.budgetLines,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createCostAccount(teamId: string, projectId: string, actorId: string, body: CreateCostAccountBody) {
    await this.assertProject(teamId, projectId);
    let parentPath: string | null = null;
    if (body.parentId) {
      const parent = await prisma.costAccount.findFirst({
        where: { id: body.parentId, projectId },
        select: { path: true },
      });
      if (!parent) throw Errors.badRequest('Parent cost account not found in this project');
      parentPath = parent.path;
    }
    const dupe = await prisma.costAccount.findFirst({
      where: { projectId, code: body.code },
      select: { id: true },
    });
    if (dupe) throw Errors.conflict('A cost account with this code already exists');
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.costAccount.create({
        data: { teamId, projectId, parentId: body.parentId ?? null, code: body.code, name: body.name, path: 'pending' },
      });
      const path = parentPath ? `${parentPath}/${row.id}` : `/${row.id}`;
      return tx.costAccount.update({ where: { id: row.id }, data: { path } });
    });
    await logActivity(prisma, { teamId, actorId, action: 'cost_account.created', meta: { projectId, costAccountId: created.id } });
    return (await this.listCostAccounts(teamId, projectId)).find((a) => a.id === created.id)!;
  }

  async updateCostAccount(teamId: string, projectId: string, id: string, actorId: string, body: UpdateCostAccountBody) {
    await this.assertProject(teamId, projectId);
    const acct = await prisma.costAccount.findFirst({ where: { id, projectId }, select: { id: true } });
    if (!acct) throw Errors.notFound('Cost account not found');
    await prisma.costAccount.update({ where: { id }, data: { ...(body.name !== undefined && { name: body.name }) } });
    await logActivity(prisma, { teamId, actorId, action: 'cost_account.updated', meta: { projectId, costAccountId: id } });
    return (await this.listCostAccounts(teamId, projectId)).find((a) => a.id === id)!;
  }

  async deleteCostAccount(teamId: string, projectId: string, id: string, actorId: string): Promise<void> {
    await this.assertProject(teamId, projectId);
    const acct = await prisma.costAccount.findFirst({
      where: { id, projectId },
      include: { _count: { select: { children: true, budgetLines: true, commitments: true, actualCostEntries: true, expenses: true } } },
    });
    if (!acct) throw Errors.notFound('Cost account not found');
    if (acct.isDefault) throw Errors.conflict('The DEFAULT cost account cannot be deleted');
    const c = acct._count;
    if (c.children || c.budgetLines || c.commitments || c.actualCostEntries || c.expenses) {
      throw Errors.conflict('Cost account has linked records; remove them first');
    }
    await prisma.costAccount.delete({ where: { id } });
    await logActivity(prisma, { teamId, actorId, action: 'cost_account.deleted', meta: { projectId, costAccountId: id } });
  }

  // ---- Budget lines (planned value) --------------------------------------
  async listBudgetLines(teamId: string, projectId: string) {
    await this.assertProject(teamId, projectId);
    const rows = await prisma.budgetLine.findMany({
      where: { projectId },
      include: { costAccount: { select: { code: true } } },
      orderBy: [{ createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      costAccountId: r.costAccountId,
      costAccountCode: r.costAccount?.code ?? null,
      taskId: r.taskId,
      amountMinor: r.amountMinor.toString(),
      amount: formatMinor(r.amountMinor, r.currency),
      currency: r.currency,
      source: r.source,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createBudgetLine(teamId: string, projectId: string, actorId: string, body: CreateBudgetLineBody) {
    await this.assertProject(teamId, projectId);
    const accountId = body.costAccountId ?? (await ensureDefaultCostAccount(prisma, teamId, projectId));
    const acct = await prisma.costAccount.findFirst({ where: { id: accountId, projectId }, select: { id: true } });
    if (!acct) throw Errors.badRequest('Cost account not found in this project');
    const created = await prisma.budgetLine.create({
      data: {
        teamId,
        projectId,
        costAccountId: accountId,
        taskId: body.taskId ?? null,
        amountMinor: toMinorBig(body.amountMinor),
        currency: body.currency,
        source: 'MANUAL',
        note: body.note ?? null,
      },
    });
    await logActivity(prisma, { teamId, actorId, action: 'budget_line.created', meta: { projectId, budgetLineId: created.id } });
    return (await this.listBudgetLines(teamId, projectId)).find((b) => b.id === created.id)!;
  }

  async deleteBudgetLine(teamId: string, projectId: string, id: string, actorId: string): Promise<void> {
    await this.assertProject(teamId, projectId);
    const line = await prisma.budgetLine.findFirst({ where: { id, projectId }, select: { id: true } });
    if (!line) throw Errors.notFound('Budget line not found');
    await prisma.budgetLine.delete({ where: { id } });
    await logActivity(prisma, { teamId, actorId, action: 'budget_line.deleted', meta: { projectId, budgetLineId: id } });
  }

  // ---- Commitments --------------------------------------------------------
  async listCommitments(teamId: string, projectId: string) {
    await this.assertProject(teamId, projectId);
    const rows = await prisma.commitment.findMany({ where: { projectId }, orderBy: [{ createdAt: 'desc' }] });
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      costAccountId: r.costAccountId,
      vendorName: r.vendorName,
      reference: r.reference,
      amountMinor: r.amountMinor.toString(),
      amount: formatMinor(r.amountMinor, r.currency),
      currency: r.currency,
      status: r.status,
      incurredOn: r.incurredOn ? dayString(r.incurredOn) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createCommitment(teamId: string, projectId: string, actorId: string, body: CreateCommitmentBody) {
    await this.assertProject(teamId, projectId);
    const created = await prisma.commitment.create({
      data: {
        teamId,
        projectId,
        costAccountId: body.costAccountId ?? null,
        vendorName: body.vendorName ?? null,
        reference: body.reference ?? null,
        amountMinor: toMinorBig(body.amountMinor),
        currency: body.currency,
        status: 'OPEN',
        incurredOn: body.incurredOn ? asDate(body.incurredOn) : null,
      },
    });
    await logActivity(prisma, { teamId, actorId, action: 'commitment.created', meta: { projectId, commitmentId: created.id } });
    return (await this.listCommitments(teamId, projectId)).find((c) => c.id === created.id)!;
  }

  async setCommitmentStatus(teamId: string, projectId: string, id: string, actorId: string, status: 'OPEN' | 'CLOSED' | 'CANCELLED') {
    await this.assertProject(teamId, projectId);
    const c = await prisma.commitment.findFirst({ where: { id, projectId }, select: { id: true } });
    if (!c) throw Errors.notFound('Commitment not found');
    await prisma.commitment.update({ where: { id }, data: { status } });
    await logActivity(prisma, { teamId, actorId, action: 'commitment.status_changed', meta: { projectId, commitmentId: id, status } });
    return (await this.listCommitments(teamId, projectId)).find((x) => x.id === id)!;
  }

  // ---- Expenses (approve → posts an actual) ------------------------------
  async listExpenses(teamId: string, projectId: string) {
    await this.assertProject(teamId, projectId);
    const rows = await prisma.expense.findMany({ where: { projectId }, orderBy: [{ createdAt: 'desc' }] });
    return rows.map((r) => this.expenseView(r));
  }

  private expenseView(r: {
    id: string; projectId: string; costAccountId: string | null; taskId: string | null;
    amountMinor: bigint; currency: Currency; status: string; description: string | null;
    incurredOn: Date; createdAt: Date;
  }) {
    return {
      id: r.id,
      projectId: r.projectId,
      costAccountId: r.costAccountId,
      taskId: r.taskId,
      amountMinor: r.amountMinor.toString(),
      amount: formatMinor(r.amountMinor, r.currency),
      currency: r.currency,
      status: r.status as 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED',
      description: r.description,
      incurredOn: dayString(r.incurredOn),
      createdAt: r.createdAt.toISOString(),
    };
  }

  async createExpense(teamId: string, projectId: string, actorId: string, body: CreateExpenseBody) {
    await this.assertProject(teamId, projectId);
    const created = await prisma.expense.create({
      data: {
        teamId,
        projectId,
        costAccountId: body.costAccountId ?? null,
        taskId: body.taskId ?? null,
        amountMinor: toMinorBig(body.amountMinor),
        currency: body.currency,
        status: 'SUBMITTED',
        description: body.description ?? null,
        incurredOn: asDate(body.incurredOn),
        submittedById: actorId,
      },
    });
    await logActivity(prisma, { teamId, actorId, action: 'expense.created', meta: { projectId, expenseId: created.id } });
    return this.expenseView(created);
  }

  async decideExpense(
    teamId: string,
    projectId: string,
    id: string,
    actorId: string,
    decision: 'APPROVED' | 'REJECTED',
  ) {
    await this.assertProject(teamId, projectId);
    const exp = await prisma.expense.findFirst({ where: { id, projectId } });
    if (!exp) throw Errors.notFound('Expense not found');
    if (exp.status !== 'SUBMITTED') throw Errors.conflict(`Cannot decide an expense in ${exp.status}`);
    const reportingCurrency = await reportingCurrencyFor(teamId);
    await prisma.$transaction(async (tx) => {
      await tx.expense.update({
        where: { id },
        data: { status: decision, decidedById: actorId, decidedAt: new Date() },
      });
      if (decision === 'APPROVED') {
        const accountId = exp.costAccountId ?? (await ensureDefaultCostAccount(tx, teamId, projectId));
        const fx = await convertMinor(tx, exp.amountMinor, exp.currency, reportingCurrency, exp.incurredOn);
        await tx.actualCostEntry.create({
          data: {
            teamId,
            projectId,
            costAccountId: accountId,
            taskId: exp.taskId,
            source: 'EXPENSE',
            amountMinor: exp.amountMinor,
            currency: exp.currency,
            baseAmountMinor: fx.baseAmountMinor,
            baseCurrency: reportingCurrency,
            fxRateId: fx.fxRateId,
            incurredOn: exp.incurredOn,
            description: exp.description ?? 'Expense',
            sourceExpenseId: exp.id,
            createdById: actorId,
          },
        });
      }
      await logActivity(tx, {
        teamId,
        actorId,
        action: decision === 'APPROVED' ? 'expense.approved' : 'expense.rejected',
        meta: { projectId, expenseId: id },
      });
    });
    const updated = await prisma.expense.findUniqueOrThrow({ where: { id } });
    return this.expenseView(updated);
  }

  // ---- Actual cost ledger -------------------------------------------------
  async listActuals(teamId: string, projectId: string) {
    await this.assertProject(teamId, projectId);
    const rows = await prisma.actualCostEntry.findMany({ where: { projectId }, orderBy: [{ incurredOn: 'desc' }, { createdAt: 'desc' }] });
    return rows.map((r) => this.actualView(r));
  }

  private actualView(r: {
    id: string; projectId: string; costAccountId: string | null; taskId: string | null;
    source: string; amountMinor: bigint; currency: Currency; baseAmountMinor: bigint;
    baseCurrency: Currency; incurredOn: Date; description: string | null; reversalOfId: string | null; createdAt: Date;
  }) {
    return {
      id: r.id,
      projectId: r.projectId,
      costAccountId: r.costAccountId,
      taskId: r.taskId,
      source: r.source as 'TIMESHEET' | 'EXPENSE' | 'INVOICE' | 'MANUAL',
      amountMinor: r.amountMinor.toString(),
      amount: formatMinor(r.amountMinor, r.currency),
      currency: r.currency,
      baseAmountMinor: r.baseAmountMinor.toString(),
      baseAmount: formatMinor(r.baseAmountMinor, r.baseCurrency),
      baseCurrency: r.baseCurrency,
      incurredOn: dayString(r.incurredOn),
      description: r.description,
      reversalOfId: r.reversalOfId,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async createManualActual(teamId: string, projectId: string, actorId: string, body: CreateActualCostBody) {
    await this.assertProject(teamId, projectId);
    const accountId = body.costAccountId ?? (await ensureDefaultCostAccount(prisma, teamId, projectId));
    const reportingCurrency = await reportingCurrencyFor(teamId);
    const incurredOn = asDate(body.incurredOn);
    const amount = toMinorBig(body.amountMinor);
    const fx = await convertMinor(prisma, amount, body.currency, reportingCurrency, incurredOn);
    const created = await prisma.actualCostEntry.create({
      data: {
        teamId,
        projectId,
        costAccountId: accountId,
        taskId: body.taskId ?? null,
        source: 'MANUAL',
        amountMinor: amount,
        currency: body.currency,
        baseAmountMinor: fx.baseAmountMinor,
        baseCurrency: reportingCurrency,
        fxRateId: fx.fxRateId,
        incurredOn,
        description: body.description ?? null,
        createdById: actorId,
      },
    });
    await logActivity(prisma, { teamId, actorId, action: 'actual_cost.created', meta: { projectId, actualId: created.id } });
    return this.actualView(created);
  }

  async reverseActual(teamId: string, projectId: string, id: string, actorId: string) {
    await this.assertProject(teamId, projectId);
    const orig = await prisma.actualCostEntry.findFirst({ where: { id, projectId } });
    if (!orig) throw Errors.notFound('Actual cost entry not found');
    if (orig.reversalOfId) throw Errors.conflict('Cannot reverse a reversal entry');
    const already = await prisma.actualCostEntry.findFirst({ where: { reversalOfId: id }, select: { id: true } });
    if (already) throw Errors.conflict('This entry has already been reversed');
    const created = await prisma.actualCostEntry.create({
      data: {
        teamId,
        projectId,
        costAccountId: orig.costAccountId,
        taskId: orig.taskId,
        source: orig.source,
        amountMinor: -orig.amountMinor,
        currency: orig.currency,
        baseAmountMinor: -orig.baseAmountMinor,
        baseCurrency: orig.baseCurrency,
        fxRateId: orig.fxRateId,
        incurredOn: orig.incurredOn,
        description: 'Manual reversal',
        reversalOfId: orig.id,
        createdById: actorId,
      },
    });
    await logActivity(prisma, { teamId, actorId, action: 'actual_cost.reversed', meta: { projectId, actualId: id } });
    return this.actualView(created);
  }

  // ---- FX rates (global reference data; admin) ---------------------------
  async listFxRates() {
    const rows = await prisma.fxRate.findMany({ orderBy: [{ asOf: 'desc' }] });
    return rows.map((r) => ({
      id: r.id,
      baseCurrency: r.baseCurrency,
      quoteCurrency: r.quoteCurrency,
      rate: r.rate.toString(),
      asOf: dayString(r.asOf),
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createFxRate(actorId: string, body: CreateFxRateBody) {
    const created = await prisma.fxRate.upsert({
      where: {
        baseCurrency_quoteCurrency_asOf: {
          baseCurrency: body.baseCurrency,
          quoteCurrency: body.quoteCurrency,
          asOf: asDate(body.asOf),
        },
      },
      update: { rate: new Prisma.Decimal(body.rate), source: body.source ?? null },
      create: {
        baseCurrency: body.baseCurrency,
        quoteCurrency: body.quoteCurrency,
        rate: new Prisma.Decimal(body.rate),
        asOf: asDate(body.asOf),
        source: body.source ?? null,
      },
    });
    await logActivity(prisma, { teamId: null, actorId, action: 'fx_rate.set', meta: { fxRateId: created.id } });
    return (await this.listFxRates()).find((r) => r.id === created.id)!;
  }

  // ---- Project cost summary (planned/committed/actual/remaining) ---------
  async projectCostSummary(teamId: string, projectId: string) {
    await this.assertProject(teamId, projectId);
    const reportingCurrency = await reportingCurrencyFor(teamId);
    const [budgetLines, commitments, actuals] = await Promise.all([
      prisma.budgetLine.findMany({ where: { projectId }, select: { amountMinor: true, currency: true } }),
      prisma.commitment.findMany({ where: { projectId, status: 'OPEN' }, select: { amountMinor: true, currency: true } }),
      prisma.actualCostEntry.findMany({ where: { projectId }, select: { amountMinor: true, currency: true, baseAmountMinor: true } }),
    ]);

    type Bucket = { planned: bigint; committed: bigint; actual: bigint };
    const byCur = new Map<Currency, Bucket>();
    const bump = (cur: Currency, key: keyof Bucket, v: bigint) => {
      const b = byCur.get(cur) ?? { planned: 0n, committed: 0n, actual: 0n };
      b[key] += v;
      byCur.set(cur, b);
    };
    for (const l of budgetLines) bump(l.currency, 'planned', l.amountMinor);
    for (const c of commitments) bump(c.currency, 'committed', c.amountMinor);
    for (const a of actuals) bump(a.currency, 'actual', a.amountMinor);

    const today = new Date();
    const warnings: string[] = [];
    let basePlanned = 0n;
    let baseCommitted = 0n;
    let baseActual = 0n;
    // Actuals already carry a snapshotted base amount → sum directly.
    for (const a of actuals) baseActual += a.baseAmountMinor;

    const byCurrency = [];
    for (const [currency, b] of [...byCur.entries()].sort(([a], [c]) => a.localeCompare(c))) {
      const remaining = b.planned - b.committed - b.actual;
      byCurrency.push({
        currency,
        plannedMinor: b.planned.toString(),
        committedMinor: b.committed.toString(),
        actualMinor: b.actual.toString(),
        remainingMinor: remaining.toString(),
        planned: formatMinor(b.planned, currency),
        committed: formatMinor(b.committed, currency),
        actual: formatMinor(b.actual, currency),
        remaining: formatMinor(remaining, currency),
      });
      const pf = await convertMinor(prisma, b.planned, currency, reportingCurrency, today);
      const cf = await convertMinor(prisma, b.committed, currency, reportingCurrency, today);
      if (pf.warning) warnings.push(pf.warning);
      if (cf.warning) warnings.push(cf.warning);
      basePlanned += pf.baseAmountMinor;
      baseCommitted += cf.baseAmountMinor;
    }

    const baseRemaining = basePlanned - baseCommitted - baseActual;
    return {
      projectId,
      reportingCurrency,
      byCurrency,
      base: {
        currency: reportingCurrency,
        plannedMinor: basePlanned.toString(),
        committedMinor: baseCommitted.toString(),
        actualMinor: baseActual.toString(),
        remainingMinor: baseRemaining.toString(),
        planned: formatMinor(basePlanned, reportingCurrency),
        committed: formatMinor(baseCommitted, reportingCurrency),
        actual: formatMinor(baseActual, reportingCurrency),
        remaining: formatMinor(baseRemaining, reportingCurrency),
        warnings: [...new Set(warnings)],
      },
    };
  }
}
