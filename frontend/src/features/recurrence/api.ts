import { api } from '@/lib/api';

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export interface Recurrence {
  id: string;
  sourceTaskId: string;
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday: number[];
  startsOn: string;
  endsOn: string | null;
  maxCount: number | null;
  dueOffsetDays: number | null;
  plannedOffsetDays: number | null;
  nextRunAt: string;
  spawnedCount: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RecurrenceUpsertInput {
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday?: number[];
  startsOn: string;
  endsOn?: string | null;
  maxCount?: number | null;
  dueOffsetDays?: number | null;
  plannedOffsetDays?: number | null;
  active?: boolean;
}

export async function getRecurrence(
  teamId: string,
  projectId: string,
  taskId: string,
): Promise<Recurrence | null> {
  const res = await api.get<Recurrence | ''>(
    `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
    { validateStatus: (s) => s === 200 || s === 204 },
  );
  if (res.status === 204) return null;
  return res.data as Recurrence;
}

export async function upsertRecurrence(
  teamId: string,
  projectId: string,
  taskId: string,
  input: RecurrenceUpsertInput,
): Promise<Recurrence> {
  return (
    await api.put<Recurrence>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
      input,
    )
  ).data;
}

export async function deleteRecurrence(
  teamId: string,
  projectId: string,
  taskId: string,
): Promise<void> {
  await api.delete(
    `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/recurrence`,
  );
}
