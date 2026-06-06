import { api } from '@/lib/api';

export type EmptyAllowedRoles = 'admin' | 'admin-and-manager';

export interface TrashedTask {
  kind: 'task';
  id: string;
  title: string;
  projectId: string;
  deletedAt: string;
  deletedById: string | null;
  deletedByName: string | null;
}

export interface TrashedComment {
  kind: 'comment';
  id: string;
  taskId: string;
  bodyExcerpt: string;
  deletedAt: string;
  deletedById: string | null;
  deletedByName: string | null;
}

export interface TrashContents {
  tasks: TrashedTask[];
  comments: TrashedComment[];
  emptyAllowedRoles: EmptyAllowedRoles;
}

export async function listTrash(teamId: string): Promise<TrashContents> {
  return (await api.get<TrashContents>(`/teams/${teamId}/trash`)).data;
}

export async function restoreTask(teamId: string, taskId: string): Promise<void> {
  await api.post(`/teams/${teamId}/trash/tasks/${taskId}/restore`);
}

export async function restoreComment(teamId: string, commentId: string): Promise<void> {
  await api.post(`/teams/${teamId}/trash/comments/${commentId}/restore`);
}

export async function purgeTask(teamId: string, taskId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/trash/tasks/${taskId}`);
}

export async function purgeComment(teamId: string, commentId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/trash/comments/${commentId}`);
}

export async function emptyTrash(
  teamId: string,
): Promise<{ tasksPurged: number; commentsPurged: number }> {
  return (await api.post<{ tasksPurged: number; commentsPurged: number }>(
    `/teams/${teamId}/trash/empty`,
  )).data;
}
