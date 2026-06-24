// v1.88: cross-team report aggregation. The reports endpoints are all
// per-team (`/teams/:id/reports/*`). To support an "All teams" selection on
// the Reports page we fan out one query per team (like the Calendar page) and
// merge the results client-side here — no new backend endpoint. Each merge is
// uniform over 1..N teams, so the same code path serves a single-team
// selection (merge of one = identity) and the all-teams roll-up.
import type {
  BudgetCurrencyRollup,
  BudgetProjectRow,
  BudgetReport,
  DoneReport,
  DoneTaskRow,
  OverdueTaskRow,
  SummaryReport,
  TimelinessReport,
  WorkloadRow,
} from './api';

export function mergeSummaries(rows: SummaryReport[]): SummaryReport {
  const merged: SummaryReport = {
    doneLast7Days: 0,
    overdueCount: 0,
    openCount: 0,
    byStatus: { TODO: 0, IN_PROGRESS: 0, REVIEW: 0, PENDING_APPROVAL: 0, DONE: 0 },
  };
  for (const s of rows) {
    merged.doneLast7Days += s.doneLast7Days;
    merged.overdueCount += s.overdueCount;
    merged.openCount += s.openCount;
    merged.byStatus.TODO += s.byStatus.TODO;
    merged.byStatus.IN_PROGRESS += s.byStatus.IN_PROGRESS;
    merged.byStatus.REVIEW += s.byStatus.REVIEW;
    merged.byStatus.PENDING_APPROVAL += s.byStatus.PENDING_APPROVAL;
    merged.byStatus.DONE += s.byStatus.DONE;
  }
  return merged;
}

export function mergeDoneReports(reports: DoneReport[]): DoneReport {
  const byTask = new Map<string, DoneTaskRow>();
  let windowDays = 0;
  for (const r of reports) {
    windowDays = Math.max(windowDays, r.windowDays);
    for (const item of r.items) byTask.set(item.taskId, item);
  }
  return {
    windowDays,
    items: [...byTask.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt)),
  };
}

export function mergeWorkload(reports: { items: WorkloadRow[] }[]): { items: WorkloadRow[] } {
  const byAssignee = new Map<string, WorkloadRow>();
  for (const r of reports) {
    for (const row of r.items) {
      const key = row.assigneeId ?? '__unassigned__';
      const ex = byAssignee.get(key);
      if (!ex) {
        byAssignee.set(key, {
          assigneeId: row.assigneeId,
          assigneeName: row.assigneeName,
          total: row.total,
          byStatus: { ...row.byStatus },
        });
      } else {
        ex.total += row.total;
        ex.byStatus.TODO += row.byStatus.TODO;
        ex.byStatus.IN_PROGRESS += row.byStatus.IN_PROGRESS;
        ex.byStatus.REVIEW += row.byStatus.REVIEW;
        ex.byStatus.PENDING_APPROVAL += row.byStatus.PENDING_APPROVAL;
        if (!ex.assigneeName && row.assigneeName) ex.assigneeName = row.assigneeName;
      }
    }
  }
  return { items: [...byAssignee.values()].sort((a, b) => b.total - a.total) };
}

export function mergeOverdue(reports: { items: OverdueTaskRow[] }[]): { items: OverdueTaskRow[] } {
  const byTask = new Map<string, OverdueTaskRow>();
  for (const r of reports) for (const item of r.items) byTask.set(item.taskId, item);
  return { items: [...byTask.values()].sort((a, b) => b.daysOverdue - a.daysOverdue) };
}

export function mergeTimeliness(reports: TimelinessReport[]): TimelinessReport {
  let evaluatedCount = 0;
  let behindPlanCount = 0;
  let windowDays = 0;
  let onTimeWeighted = 0;
  let varianceWeighted = 0;
  for (const r of reports) {
    evaluatedCount += r.evaluatedCount;
    behindPlanCount += r.behindPlanCount;
    windowDays = Math.max(windowDays, r.windowDays);
    // Rates are per-team averages — re-weight by each team's evaluated count
    // so the roll-up isn't skewed by a small team with an extreme rate.
    onTimeWeighted += r.onTimeRate * r.evaluatedCount;
    varianceWeighted += r.avgVarianceDays * r.evaluatedCount;
  }
  return {
    windowDays,
    evaluatedCount,
    onTimeRate: evaluatedCount > 0 ? onTimeWeighted / evaluatedCount : 0,
    avgVarianceDays: evaluatedCount > 0 ? varianceWeighted / evaluatedCount : 0,
    behindPlanCount,
  };
}

function addDecimal(a: string | null, b: string | null): string | null {
  if (a == null && b == null) return null;
  const sum = (a ? Number(a) : 0) + (b ? Number(b) : 0);
  return sum.toFixed(2);
}

export function mergeBudget(reports: BudgetReport[]): BudgetReport {
  const projects: BudgetProjectRow[] = [];
  const byCurrency = new Map<string, BudgetCurrencyRollup>();
  for (const r of reports) {
    projects.push(...r.projects);
    for (const roll of r.rollupByCurrency) {
      const ex = byCurrency.get(roll.currency);
      if (!ex) {
        byCurrency.set(roll.currency, { ...roll });
      } else {
        ex.projectCount += roll.projectCount;
        ex.projectsWithBudget += roll.projectsWithBudget;
        ex.totalPlanned = addDecimal(ex.totalPlanned, roll.totalPlanned);
      }
    }
  }
  return { projects, rollupByCurrency: [...byCurrency.values()] };
}
