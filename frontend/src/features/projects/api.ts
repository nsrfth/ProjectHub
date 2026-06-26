import { api } from '@/lib/api';
import type { BudgetCurrency } from '@/lib/formatBudget';
import type { TaskLabel } from '@/features/labels/api';

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'ON_HOLD';

export type RagStatus = 'GREEN' | 'AMBER' | 'RED';

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
  // v1.92 (PMIS neutral core): optional human-facing code, unique per team.
  code: string | null;
  description: string | null;
  status: ProjectStatus;
  // v1.91 (PMIS neutral core): RAG health signal for portfolio roll-up.
  ragStatus: RagStatus;
  ragReason: string | null;
  healthUpdatedAt: string | null;
  // v1.41: budget fields. Strings (Decimal serialises to string; preserves
  // precision past Number.MAX_SAFE_INTEGER). Always two decimal places when
  // set; null when unset.
  plannedBudget: string | null;
  budgetCurrency: BudgetCurrency;
  startDate: string | null;
  endDate: string | null;
  labels: TaskLabel[];
  // v1.89: per-project correspondence (دبیرخانه) module flag. Set by a global
  // admin in Settings → Correspondence module; the SPA gates the nav entry +
  // routes on it. Optional on the wire for forward-compat with older responses.
  correspondenceEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

function normalizeProject<P extends Project>(p: P): P {
  return {
    ...p,
    labels: p.labels ?? [],
    code: p.code ?? null,
    ragStatus: p.ragStatus ?? 'GREEN',
    ragReason: p.ragReason ?? null,
    healthUpdatedAt: p.healthUpdatedAt ?? null,
  };
}

export async function listProjects(teamId: string): Promise<Project[]> {
  const rows = (await api.get<Project[]>(`/teams/${teamId}/projects`)).data;
  return rows.map(normalizeProject);
}

// v1.40: cross-team list — every project the caller can see across every
// team they belong to. Each row carries the parent team name/slug so the
// SPA renders a chip per row.
export interface ProjectCrossTeam extends Project {
  teamName: string;
  teamSlug: string;
}

export async function listAllProjects(): Promise<ProjectCrossTeam[]> {
  const rows = (await api.get<ProjectCrossTeam[]>('/projects')).data;
  return rows.map(normalizeProject);
}

export async function createProject(
  teamId: string,
  input: {
    name: string;
    description?: string;
    status?: ProjectStatus;
    // v1.92 (PMIS neutral core): optional human-facing project code.
    code?: string | null;
    // v1.85: selectable owner at creation. Omitted → server defaults to creator.
    ownerId?: string | null;
    accountableId?: string | null;
    // v1.41: optional budgets at create time. number | string | null.
    plannedBudget?: number | string | null;
    budgetCurrency?: BudgetCurrency;
    startDate?: string | null;
    endDate?: string | null;
    labelIds?: string[];
    // v1.98 (PMIS R2): the project profile to snapshot at create. Omitted →
    // server resolves group/team default → system NEUTRAL.
    profileId?: string;
  },
): Promise<Project> {
  return normalizeProject((await api.post<Project>(`/teams/${teamId}/projects`, input)).data);
}

export async function updateProject(
  teamId: string,
  projectId: string,
  input: {
    name?: string;
    description?: string | null;
    status?: ProjectStatus;
    // v1.92 (PMIS neutral core): optional human-facing project code.
    code?: string | null;
    // v1.86: reassignable owner. Owner = FULL access; server validates the new
    // owner is a team member and that the caller is the owner or a global ADMIN.
    ownerId?: string | null;
    accountableId?: string | null;
    // v1.41: budget PATCH. undefined leaves the field; null clears it.
    plannedBudget?: number | string | null;
    budgetCurrency?: BudgetCurrency;
    startDate?: string | null;
    endDate?: string | null;
    labelIds?: string[];
  },
): Promise<Project> {
  return normalizeProject(
    (await api.patch<Project>(`/teams/${teamId}/projects/${projectId}`, input)).data,
  );
}

export async function deleteProject(teamId: string, projectId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/projects/${projectId}`);
}

// v1.88: per-project delegates with GRANULAR capabilities — the owner/admin
// grants each member a subset of edit capabilities on this project. FULL implies
// all the rest. Owner/admin only; non-owners get 404 from these endpoints.
export type DelegateCapability =
  | 'FULL'
  | 'EDIT_TITLES'
  | 'EDIT_DETAILS'
  | 'EDIT_DATES'
  | 'CHANGE_RESPONSIBLE'
  | 'DELETE_TASKS';

export interface ProjectDelegate {
  userId: string;
  capabilities: DelegateCapability[];
}

export async function getProjectDelegates(
  teamId: string,
  projectId: string,
): Promise<ProjectDelegate[]> {
  return (
    await api.get<{ delegates: ProjectDelegate[] }>(
      `/teams/${teamId}/projects/${projectId}/delegates`,
    )
  ).data.delegates;
}

export async function setProjectDelegates(
  teamId: string,
  projectId: string,
  delegates: ProjectDelegate[],
): Promise<ProjectDelegate[]> {
  return (
    await api.put<{ delegates: ProjectDelegate[] }>(
      `/teams/${teamId}/projects/${projectId}/delegates`,
      { delegates },
    )
  ).data.delegates;
}

export interface MyDelegateStatus {
  isDelegate: boolean;
  capabilities: DelegateCapability[];
}

// Self-scoped: the current user's delegate capabilities on this project.
// Readable by any team member (unlike the owner-only list above) so the
// task/subtask UI can unlock the controls they're allowed to use.
export async function getMyDelegateStatus(
  teamId: string,
  projectId: string,
): Promise<MyDelegateStatus> {
  return (
    await api.get<MyDelegateStatus>(`/teams/${teamId}/projects/${projectId}/delegates/me`)
  ).data;
}

// v1.91 (PMIS neutral core): update a project's RAG health status.
// Gated on project WRITE (owner / project.write_all / FULL group grant).
export async function updateProjectHealth(
  teamId: string,
  projectId: string,
  input: { ragStatus: RagStatus; ragReason?: string | null },
): Promise<Project> {
  return normalizeProject(
    (await api.put<Project>(`/teams/${teamId}/projects/${projectId}/health`, input)).data,
  );
}
