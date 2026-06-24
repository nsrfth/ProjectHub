import type { Prisma, TaskPriority, TaskStatus } from '@prisma/client';

export const OPEN_WORKLOAD_STATUSES: TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'REVIEW',
  'PENDING_APPROVAL',
];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type WorkloadWindow = 'all' | 'overdue' | 'this_week' | 'next_week';

export type WorkloadDueBucketKey = 'overdue' | 'this_week' | 'next_week' | 'later' | 'no_due';

export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  URGENT: 4,
};

export interface WorkloadDueBucketCounts {
  overdue: number;
  this_week: number;
  next_week: number;
  later: number;
  no_due: number;
}

export interface WorkloadOpenByStatus {
  TODO: number;
  IN_PROGRESS: number;
  REVIEW: number;
  PENDING_APPROVAL: number;
}

export interface WorkloadTaskSlice {
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  assigneeId: string | null;
  assigneeName: string | null;
}

export function emptyDueBuckets(): WorkloadDueBucketCounts {
  return { overdue: 0, this_week: 0, next_week: 0, later: 0, no_due: 0 };
}

export function emptyOpenByStatus(): WorkloadOpenByStatus {
  return { TODO: 0, IN_PROGRESS: 0, REVIEW: 0, PENDING_APPROVAL: 0 };
}

export function getDueWindowBounds(now = new Date()) {
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const thisWeekEnd = new Date(todayStart.getTime() + 7 * MS_PER_DAY);
  const nextWeekEnd = new Date(todayStart.getTime() + 14 * MS_PER_DAY);
  return { todayStart, thisWeekEnd, nextWeekEnd };
}

export function classifyWorkloadDueBucket(
  dueDate: Date | null,
  now = new Date(),
): WorkloadDueBucketKey {
  if (!dueDate) return 'no_due';
  const { todayStart, thisWeekEnd, nextWeekEnd } = getDueWindowBounds(now);
  if (dueDate < todayStart) return 'overdue';
  if (dueDate < thisWeekEnd) return 'this_week';
  if (dueDate < nextWeekEnd) return 'next_week';
  return 'later';
}

export function buildWorkloadTaskWhere(
  teamId: string,
  opts: { projectId?: string; window?: WorkloadWindow },
): Prisma.TaskWhereInput {
  const base: Prisma.TaskWhereInput = {
    teamId,
    deletedAt: null,
    status: { in: OPEN_WORKLOAD_STATUSES },
  };
  if (opts.projectId) base.projectId = opts.projectId;

  const window = opts.window ?? 'all';
  if (window === 'all') return base;

  const { todayStart, thisWeekEnd, nextWeekEnd } = getDueWindowBounds();
  if (window === 'overdue') {
    return { ...base, dueDate: { lt: todayStart, not: null } };
  }
  if (window === 'this_week') {
    return { ...base, dueDate: { gte: todayStart, lt: thisWeekEnd } };
  }
  if (window === 'next_week') {
    return { ...base, dueDate: { gte: thisWeekEnd, lt: nextWeekEnd } };
  }
  return base;
}

export interface WorkloadListRow {
  assigneeId: string | null;
  assigneeName: string | null;
  total: number;
  byStatus: WorkloadOpenByStatus;
}

export interface WorkloadDetailRow {
  userId: string | null;
  name: string | null;
  openByStatus: WorkloadOpenByStatus;
  byDueBucket: WorkloadDueBucketCounts;
  total: number;
  weightedTotal: number;
}

export function aggregateWorkloadList(tasks: WorkloadTaskSlice[]): WorkloadListRow[] {
  const buckets = new Map<string, WorkloadListRow>();
  for (const t of tasks) {
    const key = t.assigneeId ?? '__unassigned__';
    let b = buckets.get(key);
    if (!b) {
      b = {
        assigneeId: t.assigneeId,
        assigneeName: t.assigneeName,
        total: 0,
        byStatus: emptyOpenByStatus(),
      };
      buckets.set(key, b);
    }
    b.total += 1;
    if (
      t.status === 'TODO' ||
      t.status === 'IN_PROGRESS' ||
      t.status === 'REVIEW' ||
      t.status === 'PENDING_APPROVAL'
    ) {
      b.byStatus[t.status] += 1;
    }
  }
  return [...buckets.values()].sort((a, b) => b.total - a.total);
}

export function aggregateWorkloadDetail(
  tasks: WorkloadTaskSlice[],
  weighted: boolean,
): WorkloadDetailRow[] {
  const buckets = new Map<string, WorkloadDetailRow>();
  for (const t of tasks) {
    const key = t.assigneeId ?? '__unassigned__';
    let b = buckets.get(key);
    if (!b) {
      b = {
        userId: t.assigneeId,
        name: t.assigneeName,
        openByStatus: emptyOpenByStatus(),
        byDueBucket: emptyDueBuckets(),
        total: 0,
        weightedTotal: 0,
      };
      buckets.set(key, b);
    }
    b.total += 1;
    if (
      t.status === 'TODO' ||
      t.status === 'IN_PROGRESS' ||
      t.status === 'REVIEW' ||
      t.status === 'PENDING_APPROVAL'
    ) {
      b.openByStatus[t.status] += 1;
    }
    const dueBucket = classifyWorkloadDueBucket(t.dueDate);
    b.byDueBucket[dueBucket] += 1;
    b.weightedTotal += weighted ? PRIORITY_WEIGHT[t.priority] : 1;
  }
  return [...buckets.values()].sort((a, b) => b.total - a.total);
}
