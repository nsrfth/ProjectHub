import { api } from '@/lib/api';

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface TaskLabel {
  id: string;
  name: string;
  color: string;
}

export interface TaskSubtask {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  position: number;
}

export interface Task {
  id: string;
  projectId: string;
  teamId: string;
  creatorId: string;
  assigneeId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  doneAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  labels: TaskLabel[];
  subtasks: TaskSubtask[];
}

export async function listTasks(
  teamId: string,
  projectId: string,
  filter?: { status?: TaskStatus },
): Promise<Task[]> {
  return (
    await api.get<Task[]>(`/teams/${teamId}/projects/${projectId}/tasks`, {
      params: filter,
    })
  ).data;
}

export async function createTask(
  teamId: string,
  projectId: string,
  input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    assigneeId?: string | null;
    dueDate?: string | null;
    doneAt?: string | null;
  },
): Promise<Task> {
  return (await api.post<Task>(`/teams/${teamId}/projects/${projectId}/tasks`, input)).data;
}

export async function updateTask(
  teamId: string,
  projectId: string,
  taskId: string,
  input: Partial<{
    title: string;
    description: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    assigneeId: string | null;
    dueDate: string | null;
    doneAt: string | null;
  }>,
): Promise<Task> {
  return (
    await api.patch<Task>(`/teams/${teamId}/projects/${projectId}/tasks/${taskId}`, input)
  ).data;
}

export async function deleteTask(
  teamId: string,
  projectId: string,
  taskId: string,
): Promise<void> {
  await api.delete(`/teams/${teamId}/projects/${projectId}/tasks/${taskId}`);
}
