import { api } from '@/lib/api';
import type { BudgetCurrency } from '@/lib/formatBudget';

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'ON_HOLD';

export interface Project {
  id: string;
  teamId: string;
  ownerId: string;
  // v1.17: RACI "Accountable" person. Null when unset OR when the user has
  // been deleted (FK SetNull). accountableName is provided alongside so the
  // UI doesn't need a second round-trip to render the label.
  accountableId: string | null;
  accountableName: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  // v1.41: budget fields. Strings (Decimal serialises to string; preserves
  // precision past Number.MAX_SAFE_INTEGER). Always two decimal places when
  // set; null when unset.
  plannedBudget: string | null;
  actualSpent: string | null;
  budgetCurrency: BudgetCurrency;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listProjects(teamId: string): Promise<Project[]> {
  return (await api.get<Project[]>(`/teams/${teamId}/projects`)).data;
}

// v1.40: cross-team list — every project the caller can see across every
// team they belong to. Each row carries the parent team name/slug so the
// SPA renders a chip per row.
export interface ProjectCrossTeam extends Project {
  teamName: string;
  teamSlug: string;
}

export async function listAllProjects(): Promise<ProjectCrossTeam[]> {
  return (await api.get<ProjectCrossTeam[]>('/projects')).data;
}

export async function createProject(
  teamId: string,
  input: {
    name: string;
    description?: string;
    status?: ProjectStatus;
    accountableId?: string | null;
    // v1.41: optional budgets at create time. number | string | null.
    plannedBudget?: number | string | null;
    actualSpent?: number | string | null;
    budgetCurrency?: BudgetCurrency;
    startDate?: string | null;
    endDate?: string | null;
  },
): Promise<Project> {
  return (await api.post<Project>(`/teams/${teamId}/projects`, input)).data;
}

export async function updateProject(
  teamId: string,
  projectId: string,
  input: {
    name?: string;
    description?: string | null;
    status?: ProjectStatus;
    accountableId?: string | null;
    // v1.41: budget PATCH. undefined leaves the field; null clears it.
    plannedBudget?: number | string | null;
    actualSpent?: number | string | null;
    budgetCurrency?: BudgetCurrency;
    startDate?: string | null;
    endDate?: string | null;
  },
): Promise<Project> {
  return (await api.patch<Project>(`/teams/${teamId}/projects/${projectId}`, input)).data;
}

export async function deleteProject(teamId: string, projectId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/projects/${projectId}`);
}
