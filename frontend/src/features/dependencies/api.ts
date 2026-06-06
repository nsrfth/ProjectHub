import { api } from '@/lib/api';

export type DependencyType = 'FINISH_TO_START' | 'RELATES_TO';
export type DependencyEnforcement = 'off' | 'warn' | 'block';
export type DepTaskStatus = 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';

export interface DependencyEdge {
  id: string;
  type: DependencyType;
  createdAt: string;
  // The OTHER task on the edge. For `blockedBy` it's the blocker; for
  // `blocking` it's the dependent.
  task: { id: string; title: string; status: DepTaskStatus; projectId: string };
}

export interface DependencyList {
  blockedBy: DependencyEdge[];
  blocking: DependencyEdge[];
  enforcement: DependencyEnforcement;
}

function url(teamId: string, projectId: string, taskId: string, extra = ''): string {
  return `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/dependencies${extra}`;
}

export async function listDependencies(
  teamId: string,
  projectId: string,
  taskId: string,
): Promise<DependencyList> {
  return (await api.get<DependencyList>(url(teamId, projectId, taskId))).data;
}

export async function addDependency(
  teamId: string,
  projectId: string,
  taskId: string,
  input: { dependsOnId: string; type?: DependencyType },
): Promise<DependencyEdge> {
  return (await api.post<DependencyEdge>(url(teamId, projectId, taskId), input)).data;
}

export async function removeDependency(
  teamId: string,
  projectId: string,
  taskId: string,
  dependencyId: string,
): Promise<void> {
  await api.delete(url(teamId, projectId, taskId, `/${dependencyId}`));
}
