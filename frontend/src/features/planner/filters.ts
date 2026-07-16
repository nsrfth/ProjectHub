import type { Task, TaskPriority, TaskStatus } from '@/features/tasks/api';
import { taskProgressPercent } from './progress';

export interface TaskFilterState {
  status?: TaskStatus | '';
  priority?: TaskPriority | '';
  assigneeId?: string | '';
  projectId?: string | '';
  labelIds?: string[];
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}

export function applyTaskFilters(tasks: Task[], filters: TaskFilterState): Task[] {
  let out = tasks;
  if (filters.status) {
    out = out.filter((t) => t.status === filters.status);
  }
  if (filters.priority) {
    out = out.filter((t) => t.priority === filters.priority);
  }
  if (filters.assigneeId) {
    if (filters.assigneeId === '__unassigned__') {
      out = out.filter((t) => !t.assigneeId);
    } else {
      out = out.filter((t) => t.assigneeId === filters.assigneeId);
    }
  }
  if (filters.projectId) {
    out = out.filter((t) => t.projectId === filters.projectId);
  }
  if (filters.labelIds && filters.labelIds.length > 0) {
    const set = new Set(filters.labelIds);
    out = out.filter((t) => t.labels.some((l) => set.has(l.id)));
  }
  if (filters.search?.trim()) {
    const q = filters.search.trim().toLowerCase();
    out = out.filter((t) => t.title.toLowerCase().includes(q));
  }
  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom).getTime();
    out = out.filter((t) => t.dueDate && new Date(t.dueDate).getTime() >= from);
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo).getTime();
    out = out.filter((t) => t.dueDate && new Date(t.dueDate).getTime() <= to);
  }
  return out;
}

export type TaskSortKey =
  | 'title'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'dueDate'
  | 'progress'
  | 'createdAt'
  | 'project';

const STATUS_RANK: Record<TaskStatus, number> = {
  TODO: 0,
  IN_PROGRESS: 1,
  ON_HOLD: 2,
  REVIEW: 3,
  PENDING_APPROVAL: 4,
  DONE: 5,
};
const PRIORITY_RANK: Record<TaskPriority, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  URGENT: 3,
};

export function sortTasks(
  tasks: Task[],
  key: TaskSortKey,
  dir: 'asc' | 'desc',
  projectNames?: Map<string, string>,
  assigneeNames?: Map<string, string>,
): Task[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    const va = sortValue(a, key, projectNames, assigneeNames);
    const vb = sortValue(b, key, projectNames, assigneeNames);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  });
}

function sortValue(
  t: Task,
  key: TaskSortKey,
  projectNames?: Map<string, string>,
  assigneeNames?: Map<string, string>,
): string | number | null {
  switch (key) {
    case 'title':
      return t.title.toLowerCase();
    case 'status':
      return STATUS_RANK[t.status];
    case 'priority':
      return PRIORITY_RANK[t.priority];
    case 'assignee':
      return t.assigneeId
        ? (assigneeNames?.get(t.assigneeId) ?? t.assigneeId).toLowerCase()
        : 'zzz_unassigned';
    case 'dueDate':
      return t.dueDate ?? null;
    case 'progress':
      return taskProgressPercent(t);
    case 'createdAt':
      return t.createdAt;
    case 'project':
      return projectNames?.get(t.projectId) ?? t.projectId;
  }
}
