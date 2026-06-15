import { z } from 'zod';

// "Tasks done in the last N days" query. Clients always pass a window in days
// rather than an absolute since/until so the server can clip pathological
// inputs (e.g. days=10000) without negotiating ranges.
export const doneTasksQuery = z.object({
  days: z.coerce.number().int().positive().max(365).default(7),
});

export const doneTaskRow = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  completedAt: z.string(),
});

export const doneReportResponse = z.object({
  windowDays: z.number().int().positive(),
  items: z.array(doneTaskRow),
});

// Per-assignee workload: open tasks grouped by assignee with status breakdown.
// Unassigned bucket has assigneeId/assigneeName = null.
export const workloadRow = z.object({
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  total: z.number().int().nonnegative(),
  byStatus: z.object({
    TODO: z.number().int().nonnegative(),
    IN_PROGRESS: z.number().int().nonnegative(),
    REVIEW: z.number().int().nonnegative(),
  }),
});

export const workloadResponse = z.object({
  items: z.array(workloadRow),
});

export const workloadDetailQuery = z.object({
  projectId: z.string().optional(),
  window: z.enum(['all', 'overdue', 'this_week', 'next_week']).optional().default('all'),
  weighted: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true')
    .default(false),
});

export const workloadDueBucketCounts = z.object({
  overdue: z.number().int().nonnegative(),
  this_week: z.number().int().nonnegative(),
  next_week: z.number().int().nonnegative(),
  later: z.number().int().nonnegative(),
  no_due: z.number().int().nonnegative(),
});

export const workloadDetailRow = z.object({
  userId: z.string().nullable(),
  name: z.string().nullable(),
  openByStatus: z.object({
    TODO: z.number().int().nonnegative(),
    IN_PROGRESS: z.number().int().nonnegative(),
    REVIEW: z.number().int().nonnegative(),
  }),
  byDueBucket: workloadDueBucketCounts,
  total: z.number().int().nonnegative(),
  weightedTotal: z.number().nonnegative(),
});

export const workloadDetailResponse = z.object({
  window: z.enum(['all', 'overdue', 'this_week', 'next_week']),
  weighted: z.boolean(),
  projectId: z.string().nullable(),
  items: z.array(workloadDetailRow),
});

export type WorkloadDetailQuery = z.infer<typeof workloadDetailQuery>;

export const overdueTaskRow = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE']),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  dueDate: z.string(),
  daysOverdue: z.number().int().nonnegative(),
});

export const overdueResponse = z.object({
  items: z.array(overdueTaskRow),
});

// Headline counts for the dashboard widget. One query, all numbers we need
// to render the summary card without hitting four separate endpoints.
export const summaryResponse = z.object({
  doneLast7Days: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
  openCount: z.number().int().nonnegative(),
  byStatus: z.object({
    TODO: z.number().int().nonnegative(),
    IN_PROGRESS: z.number().int().nonnegative(),
    REVIEW: z.number().int().nonnegative(),
    DONE: z.number().int().nonnegative(),
  }),
});

// Timeliness — planned vs actual. `days` is the trailing window; we compute
// on-time rate + average variance over completed-in-window tasks, plus a
// snapshot count of open tasks already past their plannedDate.
export const timelinessQuery = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

export const timelinessResponse = z.object({
  windowDays: z.number().int().positive(),
  evaluatedCount: z.number().int().nonnegative(),
  // 0..1; 0 if no tasks have both plannedDate and completedAt in window.
  onTimeRate: z.number().min(0).max(1),
  // Days. Positive = completed after planned (late); negative = early.
  avgVarianceDays: z.number(),
  behindPlanCount: z.number().int().nonnegative(),
});

// v1.31: upcoming-deadlines feed. Per-user (caller's assignee scope) within
// one team, due in the next N days, excluding DONE + soft-deleted. The
// `days` cap is intentionally tight — this is a dashboard widget, not a
// data export. Ordered by dueDate ascending.
export const upcomingTasksQuery = z.object({
  days: z.coerce.number().int().positive().max(30).default(7),
});

export const upcomingTaskRow = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE']),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
  dueDate: z.string(),
  // Negative when the due date already passed today (caller normally hides
  // overdue items via /reports/overdue, but the endpoint still returns them
  // when they fall inside the lookback window — the client decides what to
  // show).
  daysUntil: z.number().int(),
});

export const upcomingResponse = z.object({
  windowDays: z.number().int().positive(),
  items: z.array(upcomingTaskRow),
});

// v1.31: team-scoped activity feed. Reads the existing Activity table (which
// activityLogger already denormalises teamId onto) ordered newest-first and
// capped per request — the dashboard widget shows ~10–20 entries, and a
// real per-team audit log is what /audit is for.
export const teamActivityQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const teamActivityRow = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  // "(deleted user)" when actor was unlinked; "(system)" when no actor (the
  // scheduler / SCIM auto-provision emits these).
  actorName: z.string(),
  action: z.string(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  meta: z.record(z.unknown()),
  createdAt: z.string(),
});

export const teamActivityResponse = z.object({
  items: z.array(teamActivityRow),
});

export const budgetProjectRow = z.object({
  projectId: z.string(),
  projectName: z.string(),
  currency: z.enum(['IRR', 'EUR', 'USD']),
  hasBudget: z.boolean(),
  plannedBudget: z.string().nullable(),
  actualSpent: z.string().nullable(),
  variance: z.string().nullable(),
  variancePct: z.string().nullable(),
  utilizationPct: z.string().nullable(),
  overBudget: z.boolean(),
});

export const budgetCurrencyRollup = z.object({
  currency: z.enum(['IRR', 'EUR', 'USD']),
  projectCount: z.number().int().nonnegative(),
  projectsWithBudget: z.number().int().nonnegative(),
  totalPlanned: z.string().nullable(),
  totalActual: z.string().nullable(),
  totalVariance: z.string().nullable(),
  overBudgetCount: z.number().int().nonnegative(),
});

export const budgetReportResponse = z.object({
  projects: z.array(budgetProjectRow),
  rollupByCurrency: z.array(budgetCurrencyRollup),
});

export type DoneTasksQuery = z.infer<typeof doneTasksQuery>;
export type TimelinessQuery = z.infer<typeof timelinessQuery>;
export type UpcomingTasksQuery = z.infer<typeof upcomingTasksQuery>;
export type TeamActivityQuery = z.infer<typeof teamActivityQuery>;
