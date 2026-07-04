import { api } from '@/lib/api';
import type { TaskPriority } from '@/features/tasks/api';

// v2.5.28 (StandaloneTask, Option C): typed client for personal tasks under
// /api/me. Owner-scoped; no team/project in the shape.

export type StandaloneStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';

export interface StandaloneTask {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  status: StandaloneStatus;
  priority: TaskPriority | null;
  dueDate: string | null;
  completedAt: string | null;
  sortOrder: number;
  promotedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ListQuery {
  status?: StandaloneStatus;
  q?: string;
  due?: 'overdue' | 'today' | 'week' | 'all';
  scope?: 'active' | 'deleted' | 'all';
}

export interface CreateBody {
  title: string;
  description?: string | null;
  priority?: TaskPriority | null;
  dueDate?: string | null;
}

export type UpdateBody = Partial<{
  title: string;
  description: string | null;
  status: StandaloneStatus;
  priority: TaskPriority | null;
  dueDate: string | null;
}>;

export interface PromoteResult {
  task: { id: string; projectId: string; teamId: string };
  standaloneTaskId: string;
  warning: string | null;
}

export async function listStandaloneTasks(q?: ListQuery): Promise<StandaloneTask[]> {
  const res = await api.get<{ items: StandaloneTask[] }>('/me/standalone-tasks', { params: q });
  return res.data.items;
}

export async function createStandaloneTask(body: CreateBody): Promise<StandaloneTask> {
  const res = await api.post<StandaloneTask>('/me/standalone-tasks', body);
  return res.data;
}

export async function updateStandaloneTask(id: string, body: UpdateBody): Promise<StandaloneTask> {
  const res = await api.patch<StandaloneTask>(`/me/standalone-tasks/${id}`, body);
  return res.data;
}

export async function deleteStandaloneTask(id: string): Promise<void> {
  await api.delete(`/me/standalone-tasks/${id}`);
}

export async function restoreStandaloneTask(id: string): Promise<StandaloneTask> {
  const res = await api.post<StandaloneTask>(`/me/standalone-tasks/${id}/restore`);
  return res.data;
}

export async function reorderStandaloneTasks(
  status: StandaloneStatus,
  orderedIds: string[],
): Promise<StandaloneTask[]> {
  const res = await api.post<{ items: StandaloneTask[] }>('/me/standalone-tasks/reorder', {
    status,
    orderedIds,
  });
  return res.data.items;
}

export async function promoteStandaloneTask(id: string, projectId: string): Promise<PromoteResult> {
  const res = await api.post<PromoteResult>(`/me/standalone-tasks/${id}/promote`, { projectId });
  return res.data;
}
