import type { Task, TaskStatus } from '@/features/tasks/api';
import type { SummaryReport, WorkloadRow } from '@/features/reports/api';
import { taskProgressPercent } from './progress';

export interface StatusSlice {
  status: TaskStatus | 'BLOCKED';
  label: string;
  count: number;
  percent: number;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'Open',
  IN_PROGRESS: 'In Progress',
  ON_HOLD: 'On Hold',
  REVIEW: 'Review',
  PENDING_APPROVAL: 'Pending approval',
  DONE: 'Completed',
};

/** Build doughnut slices from tasks or summary report. */
export function statusDistributionFromTasks(tasks: Task[]): StatusSlice[] {
  const counts: Record<TaskStatus, number> = {
    TODO: 0,
    IN_PROGRESS: 0,
    ON_HOLD: 0,
    REVIEW: 0,
    PENDING_APPROVAL: 0,
    DONE: 0,
  };
  let blocked = 0;
  for (const t of tasks) {
    counts[t.status] += 1;
    if (t.incompleteBlockerCount > 0 && t.status !== 'DONE') blocked += 1;
  }
  const total = tasks.length || 1;
  const slices: StatusSlice[] = (
    ['TODO', 'IN_PROGRESS', 'ON_HOLD', 'REVIEW', 'PENDING_APPROVAL', 'DONE'] as TaskStatus[]
  ).map(
    (s) => ({
      status: s,
      label: STATUS_LABEL[s],
      count: counts[s],
      percent: Math.round((counts[s] / total) * 100),
    }),
  );
  if (blocked > 0) {
    slices.push({
      status: 'BLOCKED',
      label: 'Blocked',
      count: blocked,
      percent: Math.round((blocked / total) * 100),
    });
  }
  return slices;
}

export function statusDistributionFromSummary(summary: SummaryReport): StatusSlice[] {
  const by = summary.byStatus;
  const total =
    by.TODO + by.IN_PROGRESS + by.REVIEW + by.DONE || 1;
  // The summary report's byStatus is a 4-state breakdown (no PENDING_APPROVAL),
  // so iterate exactly its keys (`as const`, not the widened TaskStatus[]).
  return (['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const).map((s) => ({
    status: s,
    label: STATUS_LABEL[s],
    count: by[s],
    percent: Math.round((by[s] / total) * 100),
  }));
}

export interface BarDatum {
  name: string;
  count: number;
}

export function statusBarFromTasks(tasks: Task[]): BarDatum[] {
  const slices = statusDistributionFromTasks(tasks);
  return slices.map((s) => ({ name: s.label, count: s.count }));
}

export function memberBarFromTasks(
  tasks: Task[],
  assigneeNames?: Map<string, string>,
): BarDatum[] {
  const map = new Map<string, number>();
  for (const t of tasks) {
    const key = t.assigneeId ?? '__unassigned__';
    const name =
      key === '__unassigned__' ? 'Unassigned' : (assigneeNames?.get(key) ?? 'Assigned');
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function memberBarFromWorkload(rows: WorkloadRow[]): BarDatum[] {
  return rows.map((r) => ({
    name: r.assigneeName ?? 'Unassigned',
    count: r.total,
  }));
}

export function averageProgress(tasks: Task[]): number {
  if (tasks.length === 0) return 0;
  const sum = tasks.reduce((a, t) => a + taskProgressPercent(t), 0);
  return Math.round(sum / tasks.length);
}
