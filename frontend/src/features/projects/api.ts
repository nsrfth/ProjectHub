import { api } from '@/lib/api';

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'ON_HOLD';

export interface Project {
  id: string;
  teamId: string;
  ownerId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export async function listProjects(teamId: string): Promise<Project[]> {
  return (await api.get<Project[]>(`/teams/${teamId}/projects`)).data;
}

export async function createProject(
  teamId: string,
  input: { name: string; description?: string },
): Promise<Project> {
  return (await api.post<Project>(`/teams/${teamId}/projects`, input)).data;
}

export async function updateProject(
  teamId: string,
  projectId: string,
  input: { name?: string; description?: string | null; status?: ProjectStatus },
): Promise<Project> {
  return (await api.patch<Project>(`/teams/${teamId}/projects/${projectId}`, input)).data;
}

export async function deleteProject(teamId: string, projectId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/projects/${projectId}`);
}
