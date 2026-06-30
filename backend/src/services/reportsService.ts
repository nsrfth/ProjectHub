import type { TaskPriority, TaskStatus, Currency } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { isSystemUser, maskActorName } from '../lib/systemUser.js';
import {
  buildCurrencyRollups,
  computeProjectBudgetMetrics,
  type BudgetCurrencyRollup,
} from '../lib/budgetReportMath.js';
import {
  aggregateWorkloadDetail,
  aggregateWorkloadList,
  buildWorkloadTaskWhere,
  getDueWindowBounds,
  OPEN_WORKLOAD_STATUSES,
  type WorkloadDetailRow,
  type WorkloadListRow,
  type WorkloadWindow,
} from '../lib/workloadAggregation.js';

export interface WorkloadRow extends WorkloadListRow {}

export interface DoneTaskRow {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  completedAt: Date;
}

export interface WorkloadDetailOptions {
  projectId?: string;
  window?: WorkloadWindow;
  weighted?: boolean;
}

export type WorkloadDueBucket = 'overdue' | 'this_week' | 'next_week' | 'later' | 'no_due';

export interface WorkloadDrillOptions {
  assigneeId?: string;
  status?: string;
  dueBucket?: WorkloadDueBucket;
  projectId?: string;
}

export interface WorkloadDrillRow {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
}

export type { WorkloadDetailRow };

export interface OverdueTaskRow {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  status: TaskStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: Date;
  daysOverdue: number;
}

export interface SummaryReport {
  doneLast7Days: number;
  overdueCount: number;
  openCount: number;
  byStatus: {
    TODO: number;
    IN_PROGRESS: number;
    REVIEW: number;
    PENDING_APPROVAL: number;
    DONE: number;
  };
}

// "How did we do against the plan?" — three numbers a manager wants to see:
//   onTimeRate: % of tasks completed inside their plannedDate (of those with
//               a plannedDate set)
//   avgVarianceDays: mean of (completedAt − plannedDate) in days. Positive
//                    means chronically late; negative means we beat the plan.
//   behindPlanCount: open tasks whose plannedDate is already in the past.
// All three are scoped to a trailing window of N days (default 30) so old
// data doesn't drown out recent trends.
export interface TimelinessReport {
  windowDays: number;
  evaluatedCount: number;
  onTimeRate: number; // 0..1
  avgVarianceDays: number;
  behindPlanCount: number;
}

// v1.31: upcoming-deadlines feed for the dashboard. Scoped to one team +
// one assignee (the caller); see listUpcomingForUser. Ordered by dueDate
// ascending so the soonest deadline floats to the top.
export interface UpcomingTaskRow {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date;
  daysUntil: number;
}

// v1.31: team-scoped activity feed. Newest-first, capped per request.
export interface TeamActivityRow {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface BudgetProjectRow {
  projectId: string;
  projectName: string;
  currency: Currency;
  hasBudget: boolean;
  plannedBudget: string | null;
}

export interface BudgetReport {
  projects: BudgetProjectRow[];
  rollupByCurrency: BudgetCurrencyRollup[];
}

export type { BudgetCurrencyRollup };

const OPEN_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'REVIEW', 'PENDING_APPROVAL'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class ReportsService {
  // Returns every task in this team whose completedAt is within the trailing
  // N days. Sorted newest-first so the typical "what happened this week" view
  // reads naturally. Caller (route layer) already enforces team membership.
  async listDoneTasks(teamId: string, days: number): Promise<DoneTaskRow[]> {
    const since = new Date(Date.now() - days * MS_PER_DAY);
    const rows = await prisma.task.findMany({
      where: { teamId, completedAt: { gte: since } },
      include: {
        project: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
      },
      orderBy: { completedAt: 'desc' },
    });
    return rows
      .filter((r): r is typeof r & { completedAt: Date } => r.completedAt !== null)
      .map((r) => ({
        taskId: r.id,
        taskTitle: r.title,
        projectId: r.project.id,
        projectName: r.project.name,
        assigneeId: r.assignee?.id ?? null,
        assigneeName: r.assignee?.name ?? null,
        completedAt: r.completedAt,
      }));
  }

  // Workload: open tasks grouped by assignee with per-status breakdown.
  // Single query + in-memory group — team size is small; indexes on
  // [teamId, assigneeId] cover the hot path.
  async listWorkload(teamId: string): Promise<WorkloadRow[]> {
    const tasks = await this.fetchOpenWorkloadTasks(teamId);
    return aggregateWorkloadList(tasks);
  }

  // v1.68: capacity view — per-assignee open load with due-bucket split and
  // optional priority weighting. Same task fetch as listWorkload; filters
  // are optional query params on /reports/workload/detail.
  async workloadDetail(
    teamId: string,
    opts: WorkloadDetailOptions = {},
  ): Promise<WorkloadDetailRow[]> {
    const tasks = await this.fetchOpenWorkloadTasks(teamId, {
      projectId: opts.projectId,
      window: opts.window,
    });
    return aggregateWorkloadDetail(tasks, opts.weighted ?? false);
  }

  private async fetchOpenWorkloadTasks(
    teamId: string,
    opts: { projectId?: string; window?: WorkloadWindow } = {},
  ) {
    const rows = await prisma.task.findMany({
      where: buildWorkloadTaskWhere(teamId, opts),
      select: {
        status: true,
        priority: true,
        dueDate: true,
        assignee: { select: { id: true, name: true } },
      },
    });
    return rows.map((r) => ({
      status: r.status,
      priority: r.priority,
      dueDate: r.dueDate,
      assigneeId: r.assignee?.id ?? null,
      assigneeName: r.assignee?.name ?? null,
    }));
  }

  async listOverdue(teamId: string): Promise<OverdueTaskRow[]> {
    const now = new Date();
    const rows = await prisma.task.findMany({
      where: {
        teamId,
        status: { in: OPEN_STATUSES },
        dueDate: { lt: now, not: null },
      },
      include: {
        project: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
      },
      orderBy: { dueDate: 'asc' },
    });
    return rows
      .filter((r): r is typeof r & { dueDate: Date } => r.dueDate !== null)
      .map((r) => ({
        taskId: r.id,
        taskTitle: r.title,
        projectId: r.project.id,
        projectName: r.project.name,
        status: r.status,
        assigneeId: r.assignee?.id ?? null,
        assigneeName: r.assignee?.name ?? null,
        dueDate: r.dueDate,
        daysOverdue: Math.floor((now.getTime() - r.dueDate.getTime()) / MS_PER_DAY),
      }));
  }

  // Summary — cheap aggregates used by the Dashboard widget. Single endpoint
  // so the widget doesn't have to hit four others on every navigation.
  async summary(teamId: string): Promise<SummaryReport> {
    const now = new Date();
    const since7d = new Date(now.getTime() - 7 * MS_PER_DAY);

    const [doneLast7Days, overdueCount, statusCounts] = await Promise.all([
      prisma.task.count({ where: { teamId, completedAt: { gte: since7d } } }),
      prisma.task.count({
        where: {
          teamId,
          status: { in: OPEN_STATUSES },
          dueDate: { lt: now, not: null },
        },
      }),
      prisma.task.groupBy({
        by: ['status'],
        where: { teamId },
        _count: { _all: true },
      }),
    ]);

    const byStatus = {
      TODO: 0,
      IN_PROGRESS: 0,
      REVIEW: 0,
      PENDING_APPROVAL: 0,
      DONE: 0,
    };
    for (const c of statusCounts) {
      if (c.status in byStatus) {
        byStatus[c.status as keyof typeof byStatus] = c._count._all;
      }
    }
    return {
      doneLast7Days,
      overdueCount,
      openCount:
        byStatus.TODO +
        byStatus.IN_PROGRESS +
        byStatus.REVIEW +
        byStatus.PENDING_APPROVAL,
      byStatus,
    };
  }

  // Timeliness: planned vs. actual. Only counts tasks with BOTH a plannedDate
  // and a completedAt (or open + plannedDate for behind-plan). Tasks with no
  // planned target can't be measured against it.
  async timeliness(teamId: string, days: number): Promise<TimelinessReport> {
    const now = new Date();
    const since = new Date(now.getTime() - days * MS_PER_DAY);

    const [completedWithPlan, behindPlanCount] = await Promise.all([
      // Completed in window AND had a planned target. These are the rows we
      // can compute on-time + variance from.
      prisma.task.findMany({
        where: {
          teamId,
          completedAt: { gte: since },
          plannedDate: { not: null },
        },
        select: { plannedDate: true, completedAt: true },
      }),
      // Open tasks whose plannedDate is already in the past — "behind plan
      // but not yet overdue (which is past dueDate, a stricter signal)".
      prisma.task.count({
        where: {
          teamId,
          status: { in: OPEN_STATUSES },
          plannedDate: { lt: now, not: null },
        },
      }),
    ]);

    let onTime = 0;
    let totalVarianceMs = 0;
    for (const r of completedWithPlan) {
      if (!r.plannedDate || !r.completedAt) continue;
      const variance = r.completedAt.getTime() - r.plannedDate.getTime();
      totalVarianceMs += variance;
      if (variance <= 0) onTime += 1;
    }
    const evaluatedCount = completedWithPlan.length;
    return {
      windowDays: days,
      evaluatedCount,
      onTimeRate: evaluatedCount === 0 ? 0 : onTime / evaluatedCount,
      avgVarianceDays:
        evaluatedCount === 0 ? 0 : totalVarianceMs / evaluatedCount / MS_PER_DAY,
      behindPlanCount,
    };
  }

  // v1.31: dashboard widget feed. Per-user upcoming deadlines inside one
  // team, due between today (UTC start) and today + N days inclusive.
  // Excludes DONE and soft-deleted rows. Caller (route layer) already
  // verified team membership; we just filter by assignee = userId.
  async listUpcomingForUser(
    teamId: string,
    userId: string,
    days: number,
  ): Promise<UpcomingTaskRow[]> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const horizon = new Date(todayStart.getTime() + days * MS_PER_DAY);
    const rows = await prisma.task.findMany({
      where: {
        teamId,
        assigneeId: userId,
        deletedAt: null,
        status: { in: OPEN_STATUSES },
        dueDate: { gte: todayStart, lte: horizon },
      },
      include: { project: { select: { id: true, name: true } } },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    });
    return rows
      .filter((r): r is typeof r & { dueDate: Date } => r.dueDate !== null)
      .map((r) => ({
        taskId: r.id,
        taskTitle: r.title,
        projectId: r.project.id,
        projectName: r.project.name,
        status: r.status,
        priority: r.priority,
        dueDate: r.dueDate,
        daysUntil: Math.floor(
          (r.dueDate.getTime() - todayStart.getTime()) / MS_PER_DAY,
        ),
      }));
  }

  // v1.31: team activity feed. Uses the existing Activity table (the
  // activityLogger already denormalises teamId on write — v1.x). Joins on
  // actor + task + project so the response is self-contained for the
  // dashboard list without a second round-trip.
  async listTeamActivity(teamId: string, limit: number): Promise<TeamActivityRow[]> {
    const rows = await prisma.activity.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor: { select: { id: true, name: true, isSystemUser: true, email: true } },
        task: {
          select: {
            id: true,
            title: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      actorId: a.actor && isSystemUser(a.actor) ? null : a.actorId,
      actorName: maskActorName(a.actor, a.actorId) ?? '(system)',
      action: a.action,
      taskId: a.taskId,
      taskTitle: a.task?.title ?? null,
      projectId: a.task?.project.id ?? null,
      projectName: a.task?.project.name ?? null,
      meta: (a.meta as Record<string, unknown>) ?? {},
      createdAt: a.createdAt,
    }));
  }

  // v1.90: task-level drill-down for a single workload cell. Returns the actual
  // tasks behind a count so managers can act on over-allocation directly.
  async workloadTaskDrill(
    teamId: string,
    opts: WorkloadDrillOptions = {},
  ): Promise<WorkloadDrillRow[]> {
    const where = buildWorkloadTaskWhere(teamId, { projectId: opts.projectId });

    if (opts.assigneeId === '__unassigned__') {
      where.assigneeId = null;
    } else if (opts.assigneeId) {
      where.assigneeId = opts.assigneeId;
    }

    if (opts.status) {
      where.status = opts.status as TaskStatus;
    }

    if (opts.dueBucket) {
      const { todayStart, thisWeekEnd, nextWeekEnd } = getDueWindowBounds();
      switch (opts.dueBucket) {
        case 'overdue':
          where.dueDate = { lt: todayStart, not: null };
          break;
        case 'this_week':
          where.dueDate = { gte: todayStart, lt: thisWeekEnd };
          break;
        case 'next_week':
          where.dueDate = { gte: thisWeekEnd, lt: nextWeekEnd };
          break;
        case 'later':
          where.dueDate = { gte: nextWeekEnd };
          break;
        case 'no_due':
          where.dueDate = null;
          break;
      }
    }

    const rows = await prisma.task.findMany({
      where,
      include: { project: { select: { id: true, name: true } } },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 100,
    });

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      projectId: r.project.id,
      projectName: r.project.name,
      status: r.status,
      priority: r.priority,
      dueDate: r.dueDate,
    }));
  }

  // v1.73: budget/cost report — per-project planned budget in project currency.
  // Project-level actualSpent was removed; task budgets are unchanged but not rolled up here.
  // Projects without plannedBudget are included with hasBudget=false ("no budget").
  async budgetReport(teamId: string): Promise<BudgetReport> {
    const rows = await prisma.project.findMany({
      where: { teamId },
      select: {
        id: true,
        name: true,
        plannedBudget: true,
        budgetCurrency: true,
      },
      orderBy: { name: 'asc' },
    });

    const projects: BudgetProjectRow[] = rows.map((p) => {
      const metrics = computeProjectBudgetMetrics(p.plannedBudget);
      return {
        projectId: p.id,
        projectName: p.name,
        currency: p.budgetCurrency,
        ...metrics,
      };
    });

    return {
      projects,
      rollupByCurrency: buildCurrencyRollups(projects),
    };
  }
}
