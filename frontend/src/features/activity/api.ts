import { api } from '@/lib/api';

export interface ActivityEntry {
  id: string;
  taskId: string;
  actorId: string;
  actorName: string;
  action: string;
  meta: unknown;
  createdAt: string;
}

export async function listActivity(
  teamId: string,
  projectId: string,
  taskId: string,
): Promise<ActivityEntry[]> {
  return (
    await api.get<ActivityEntry[]>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/activity`,
    )
  ).data;
}
