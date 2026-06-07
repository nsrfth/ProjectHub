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
  // v1.19: subtask technician (defaults to creator on create, manager/admin
  // gated to change post-create).
  technicianId: string | null;
  technicianName: string | null;
  position: number;
}

export interface Task {
  id: string;
  projectId: string;
  teamId: string;
  creatorId: string;
  assigneeId: string | null;
  // v1.19: "Assigned Technician" — the person actually doing the work.
  // Distinct from assignee; defaults to creator; only managers/admins can
  // change it post-create.
  technicianId: string | null;
  technicianName: string | null;
  // v1.34: optional bucket reference. Null = unbucketed. Validated
  // server-side to belong to the same project; cross-project → 400,
  // cross-team → 404.
  bucketId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  // dueDate = hard deadline; plannedDate = team's target; completedAt = actual.
  dueDate: string | null;
  plannedDate: string | null;
  completedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  labels: TaskLabel[];
  subtasks: TaskSubtask[];
  // v1.29: number of FINISH_TO_START dependencies whose blocker isn't DONE.
  // Drives the kanban lock badge + the TaskDetail status-guard preview.
  incompleteBlockerCount: number;
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
    plannedDate?: string | null;
    completedAt?: string | null;
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
    // v1.19: gated server-side (manager/admin only). The mutation surfaces
    // a 403 inline on the calling page if the role check fails.
    technicianId: string | null;
    dueDate: string | null;
    plannedDate: string | null;
    completedAt: string | null;
    // v1.34: bucket assignment. Null unbuckets, string moves, omitted = no
    // change. Service validates target bucket belongs to the same project.
    bucketId: string | null;
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

export async function reorderTask(
  teamId: string,
  projectId: string,
  taskId: string,
  input: { status: TaskStatus; beforeTaskId: string | null },
): Promise<Task> {
  return (
    await api.post<Task>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/reorder`,
      input,
    )
  ).data;
}
