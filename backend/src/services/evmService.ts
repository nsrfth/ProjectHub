import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { reportingCurrencyFor } from './costService.js';
import { CURRENCY_DECIMALS } from '../lib/money.js';
import type { EvmQuery, EvmSeriesQuery } from '../schemas/evm.js';
import type { Currency, EacMethod } from '@prisma/client';

// v2.3 (PMIS R7): Earned Value Management computations.
//
// BAC  = Budget At Completion = sum of all BudgetLines for the project (in reporting currency)
// PV   = Planned Value on `asOf` date = sum of BaselineEntry.value for entries whose
//        baselineStart ≤ asOf (time-phased from the most recent MANUAL baseline)
// EV   = Earned Value = sum of (percentComplete/100 × task budget) for all leaf tasks
// AC   = Actual Cost = sum of all ActualCostEntry.baseAmountMinor up to asOf
//
// Derived:
//   CV  = EV - AC          (cost variance; positive = under budget)
//   SV  = EV - PV          (schedule variance; positive = ahead of schedule)
//   CPI = EV / AC          (cost performance index)
//   SPI = EV / PV          (schedule performance index)
//   EAC (CPI_BASED)   = BAC / CPI   (most common)
//   EAC (SPI_BASED)   = AC + (BAC - EV) / SPI
//   EAC (TCPI_BASED)  = AC + (BAC - EV) / 1.0  (targets CPI=1 going forward)
//   VAC = BAC - EAC
//   TCPI = (BAC - EV) / (BAC - AC)

export class EvmService {
  private async assertProject(teamId: string, projectId: string) {
    const p = await prisma.project.findFirst({ where: { id: projectId, teamId }, select: { id: true } });
    if (!p) throw Errors.notFound('Project not found');
    return p;
  }

  async computeEvm(teamId: string, projectId: string, query: EvmQuery) {
    await this.assertProject(teamId, projectId);
    const currency = await reportingCurrencyFor(teamId);
    const asOf = query.asOf ? new Date(`${query.asOf}T23:59:59.999Z`) : new Date();
    const method: EacMethod = query.eacMethod ?? 'CPI_BASED';

    // BAC: sum of budget lines. amountMinor is in minor units (cents) → divide by 100.
    const budgetAgg = await prisma.budgetLine.aggregate({
      where: { projectId },
      _sum: { amountMinor: true },
    });
    const bac = Number(budgetAgg._sum.amountMinor ?? 0n) / 100;

    // PV: time-phased from the most recent baseline's BaselineEntry schedule bars
    // + the task's BudgetLine amounts (linear interpolation over the window).
    // No `plannedValueMinor` column exists — we derive it from time-fraction × budget.
    const latestBaseline = await prisma.projectBaseline.findFirst({
      where: { projectId },
      orderBy: { capturedAt: 'desc' },
      select: { id: true },
    });
    let pv = 0;
    if (latestBaseline) {
      const entries = await prisma.baselineEntry.findMany({
        where: { baselineId: latestBaseline.id },
        include: { task: { include: { budgetLines: { select: { amountMinor: true } } } } },
      });
      for (const e of entries) {
        const taskBudget = e.task.budgetLines.reduce((s, b) => s + Number(b.amountMinor) / 100, 0);
        if (!taskBudget) continue;
        const start = e.start?.getTime();
        const end = e.end?.getTime();
        const now = asOf.getTime();
        if (!start || !end || end <= start) { pv += taskBudget; continue; }
        if (now >= end) { pv += taskBudget; }
        else if (now < start) { pv += 0; }
        else { pv += taskBudget * (now - start) / (end - start); }
      }
    }

    // EV: leaf tasks only (isSummary=false, deletedAt=null) × percentComplete × budgetLine sum
    const leafTasks = await prisma.task.findMany({
      where: { projectId, deletedAt: null, isSummary: false },
      select: {
        id: true,
        percentComplete: true,
        budgetLines: { select: { amountMinor: true } },
      },
    });
    let ev = 0;
    for (const t of leafTasks) {
      const taskBudget = t.budgetLines.reduce((s, b) => s + Number(b.amountMinor) / 100, 0);
      ev += (t.percentComplete / 100) * taskBudget;
    }

    // AC: sum of actual cost entries in reporting currency.
    // baseAmountMinor uses the reporting currency's own decimal places (IRR=0, USD=2).
    const acAgg = await prisma.actualCostEntry.aggregate({
      where: { projectId, incurredOn: { lte: asOf } },
      _sum: { baseAmountMinor: true },
    });
    const reportingFactor = Math.pow(10, CURRENCY_DECIMALS[currency]);
    const ac = Number(acAgg._sum.baseAmountMinor ?? 0n) / reportingFactor;

    return this.deriveMetrics({ bac, pv, ev, ac, method, currency, asOf, projectId });
  }

  async saveSnapshot(teamId: string, projectId: string, query: EvmQuery) {
    const metrics = await this.computeEvm(teamId, projectId, query);
    // metrics are in major units; DB stores minor units → multiply by 100.
    const toMinor = (v: number) => BigInt(Math.round(v * 100));
    const snap = await prisma.evmSnapshot.create({
      data: {
        teamId,
        projectId,
        snapshotDate: new Date(metrics.asOf),
        bac: toMinor(metrics.bac),
        pv: toMinor(metrics.pv),
        ev: toMinor(metrics.ev),
        ac: toMinor(metrics.ac),
        cv: toMinor(metrics.cv),
        sv: toMinor(metrics.sv),
        cpi: metrics.cpi,
        spi: metrics.spi,
        eac: toMinor(metrics.eac),
        eacMethod: metrics.eacMethod,
        vac: toMinor(metrics.vac),
        tcpi: metrics.tcpi,
        currency: metrics.currency,
      },
    });
    return {
      ...metrics,
      id: snap.id,
      createdAt: snap.createdAt.toISOString(),
    };
  }

  async series(teamId: string, projectId: string, query: EvmSeriesQuery) {
    await this.assertProject(teamId, projectId);
    const snaps = await prisma.evmSnapshot.findMany({
      where: { projectId },
      orderBy: { snapshotDate: 'asc' },
    });
    // DB stores ×100 (saveSnapshot multiplies by 100 before write); divide back.
    return {
      items: snaps.map((s) => ({
        date: s.snapshotDate.toISOString().slice(0, 10),
        bac: Number(s.bac) / 100,
        pv: Number(s.pv) / 100,
        ev: Number(s.ev) / 100,
        ac: Number(s.ac) / 100,
        cpi: Number(s.cpi),
        spi: Number(s.spi),
      })),
    };
  }

  private deriveMetrics(p: {
    bac: number; pv: number; ev: number; ac: number;
    method: EacMethod; currency: Currency; asOf: Date; projectId: string;
  }) {
    const { bac, pv, ev, ac, method, currency, asOf, projectId } = p;
    const cv = ev - ac;
    const sv = ev - pv;
    const cpi = ac > 0 ? ev / ac : 1;
    const spi = pv > 0 ? ev / pv : 1;
    let eac: number;
    if (method === 'CPI_BASED') {
      eac = cpi > 0 ? bac / cpi : bac;
    } else if (method === 'SPI_BASED') {
      eac = spi > 0 ? ac + (bac - ev) / spi : bac;
    } else {
      eac = ac + (bac - ev); // TCPI target=1 → ETC = remaining work
    }
    const vac = bac - eac;
    const tcpi = (bac - ac) > 0 ? (bac - ev) / (bac - ac) : 0;

    return {
      projectId,
      asOf: asOf.toISOString().slice(0, 10),
      bac, pv, ev, ac, cv, sv,
      cpi: +cpi.toFixed(4),
      spi: +spi.toFixed(4),
      eac,
      eacMethod: method,
      vac,
      tcpi: +tcpi.toFixed(4),
      currency,
    };
  }
}
