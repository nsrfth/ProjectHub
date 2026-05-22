import { api } from '@/lib/api';

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export async function listComments(
  teamId: string,
  projectId: string,
  taskId: string,
): Promise<Comment[]> {
  return (
    await api.get<Comment[]>(`/teams/${teamId}/projects/${projectId}/tasks/${taskId}/comments`)
  ).data;
}

export async function createComment(
  teamId: string,
  projectId: string,
  taskId: string,
  body: string,
): Promise<Comment> {
  return (
    await api.post<Comment>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/comments`,
      { body },
    )
  ).data;
}

export async function updateComment(
  teamId: string,
  projectId: string,
  taskId: string,
  commentId: string,
  body: string,
): Promise<Comment> {
  return (
    await api.patch<Comment>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/comments/${commentId}`,
      { body },
    )
  ).data;
}

export async function deleteComment(
  teamId: string,
  projectId: string,
  taskId: string,
  commentId: string,
): Promise<void> {
  await api.delete(
    `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/comments/${commentId}`,
  );
}
