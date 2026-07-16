import type { Task } from '@/features/tasks/api';
import {
  PROGRESS_BUCKET_LABEL,
  PROGRESS_BUCKET_ORDER,
  progressBucket,
  type ProgressBucket,
} from './progress';

export type BoardGroupBy = 'status' | 'assignee' | 'progress' | 'dueDate' | 'label';

export const BOARD_GROUP_BY_ORDER: BoardGroupBy[] = [
  'status',
  'assignee',
  'progress',
  'dueDate',
  'label',
];

export const BOARD_GROUP_BY_LABEL: Record<BoardGroupBy, string> = {
  status: 'Status',
  assignee: 'Assignee',
  progress: 'Progress',
  dueDate: 'Due Date',
  label: 'Label',
};

export type DueDateBucket =
  | 'overdue'
  | 'today'
  | 'this_week'
  | 'next_week'
  | 'future'
  | 'no_due';

export const DUE_DATE_BUCKET_ORDER: DueDateBucket[] = [
  'overdue',
  'today',
  'this_week',
  'next_week',
  'future',
  'no_due',
];

export const DUE_DATE_BUCKET_LABEL: Record<DueDateBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  this_week: 'This Week',
  next_week: 'Next Week',
  future: 'Future',
  no_due: 'No Due Date',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

export function dueDateBucket(dueDate: string | null, now = new Date()): DueDateBucket {
  if (!dueDate) return 'no_due';
  const due = new Date(dueDate);
  const todayStart = startOfUtcDay(now);
  const todayEnd = endOfUtcDay(now);
  const weekEnd = new Date(todayStart.getTime() + 7 * MS_PER_DAY);
  const nextWeekEnd = new Date(todayStart.getTime() + 14 * MS_PER_DAY);

  if (due < todayStart) return 'overdue';
  if (due >= todayStart && due < todayEnd) return 'today';
  if (due >= todayEnd && due < weekEnd) return 'this_week';
  if (due >= weekEnd && due < nextWeekEnd) return 'next_week';
  return 'future';
}

export interface BoardColumn<TKey extends string = string> {
  key: TKey;
  label: string;
  tasks: Task[];
}

export function groupTasksByStatus(tasks: Task[]): BoardColumn<Task['status']>[] {
  const order: Task['status'][] = ['TODO', 'IN_PROGRESS', 'ON_HOLD', 'REVIEW', 'PENDING_APPROVAL', 'DONE'];
  const labels: Record<Task['status'], string> = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    ON_HOLD: 'On hold',
    REVIEW: 'Review',
    PENDING_APPROVAL: 'Pending approval',
    DONE: 'Done',
  };
  const map = new Map<Task['status'], Task[]>();
  for (const s of order) map.set(s, []);
  for (const t of tasks) map.get(t.status)!.push(t);
  return order.map((key) => ({ key, label: labels[key], tasks: map.get(key)! }));
}

export function groupTasksByAssignee(
  tasks: Task[],
  assigneeNames?: Map<string, string>,
): BoardColumn<string>[] {
  const map = new Map<string, { label: string; tasks: Task[] }>();
  for (const t of tasks) {
    const key = t.assigneeId ?? '__unassigned__';
    const display =
      key === '__unassigned__'
        ? 'Unassigned'
        : (assigneeNames?.get(key) ?? 'Assigned');
    let entry = map.get(key);
    if (!entry) {
      entry = { label: display, tasks: [] };
      map.set(key, entry);
    }
    entry.tasks.push(t);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, label: v.label, tasks: v.tasks }))
    .sort((a, b) => {
      if (a.key === '__unassigned__') return 1;
      if (b.key === '__unassigned__') return -1;
      return a.label.localeCompare(b.label);
    });
}

export function groupTasksByProgress(tasks: Task[]): BoardColumn<ProgressBucket>[] {
  const map = new Map<ProgressBucket, Task[]>();
  for (const b of PROGRESS_BUCKET_ORDER) map.set(b, []);
  for (const t of tasks) map.get(progressBucket(t))!.push(t);
  return PROGRESS_BUCKET_ORDER.map((key) => ({
    key,
    label: PROGRESS_BUCKET_LABEL[key],
    tasks: map.get(key)!,
  }));
}

export function groupTasksByDueDate(tasks: Task[]): BoardColumn<DueDateBucket>[] {
  const map = new Map<DueDateBucket, Task[]>();
  for (const b of DUE_DATE_BUCKET_ORDER) map.set(b, []);
  for (const t of tasks) map.get(dueDateBucket(t.dueDate))!.push(t);
  return DUE_DATE_BUCKET_ORDER.map((key) => ({
    key,
    label: DUE_DATE_BUCKET_LABEL[key],
    tasks: map.get(key)!,
  }));
}

export function groupTasksByLabel(
  tasks: Task[],
  teamLabels: { id: string; name: string }[],
): BoardColumn<string>[] {
  const map = new Map<string, { label: string; tasks: Task[] }>();
  map.set('__no_label__', { label: 'No Label', tasks: [] });
  for (const l of teamLabels) {
    map.set(l.id, { label: l.name, tasks: [] });
  }
  for (const t of tasks) {
    if (t.labels.length === 0) {
      map.get('__no_label__')!.tasks.push(t);
    } else {
      // First label only — avoids duplicating cards across columns.
      const first = t.labels[0]!;
      const entry = map.get(first.id);
      if (entry) entry.tasks.push(t);
      else map.get('__no_label__')!.tasks.push(t);
    }
  }
  const cols: BoardColumn<string>[] = [];
  if (map.get('__no_label__')!.tasks.length > 0 || tasks.every((t) => t.labels.length === 0)) {
    cols.push({ key: '__no_label__', label: 'No Label', tasks: map.get('__no_label__')!.tasks });
  }
  for (const l of teamLabels) {
    const entry = map.get(l.id)!;
    if (entry.tasks.length > 0) {
      cols.push({ key: l.id, label: entry.label, tasks: entry.tasks });
    }
  }
  return cols;
}

export function groupTasks(
  tasks: Task[],
  groupBy: BoardGroupBy,
  teamLabels: { id: string; name: string }[],
  assigneeNames?: Map<string, string>,
): BoardColumn<string>[] {
  switch (groupBy) {
    case 'status':
      return groupTasksByStatus(tasks) as BoardColumn<string>[];
    case 'assignee':
      return groupTasksByAssignee(tasks, assigneeNames);
    case 'progress':
      return groupTasksByProgress(tasks) as BoardColumn<string>[];
    case 'dueDate':
      return groupTasksByDueDate(tasks) as BoardColumn<string>[];
    case 'label':
      return groupTasksByLabel(tasks, teamLabels);
  }
}
