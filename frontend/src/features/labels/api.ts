import { api } from '@/lib/api';

export interface Label {
  id: string;
  // v1.80: null for a global "predefined" label (admin-managed, every team).
  teamId: string | null;
  name: string;
  color: string;
  isPredefined: boolean;
}

// The shape attached to a task via Task.labels[] — same fields, without teamId
// since the parent task already tells you which team you're in.
export interface TaskLabel {
  id: string;
  name: string;
  color: string;
}

export async function listLabels(teamId: string): Promise<Label[]> {
  return (await api.get<Label[]>(`/teams/${teamId}/labels`)).data;
}

export async function createLabel(
  teamId: string,
  input: { name: string; color: string },
): Promise<Label> {
  return (await api.post<Label>(`/teams/${teamId}/labels`, input)).data;
}

// v1.36: rename / recolour a label. Backend already supports this via
// PATCH; we just needed the client wrapper for the LabelsPage UI.
export async function updateLabel(
  teamId: string,
  labelId: string,
  input: { name?: string; color?: string },
): Promise<Label> {
  return (await api.patch<Label>(`/teams/${teamId}/labels/${labelId}`, input)).data;
}

export async function deleteLabel(teamId: string, labelId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/labels/${labelId}`);
}

// v1.80: global "predefined" labels. Admin-only (GlobalRole=ADMIN); these
// appear in every team's catalog via listLabels (flagged isPredefined).
export async function listGlobalLabels(): Promise<Label[]> {
  return (await api.get<Label[]>(`/admin/labels`)).data;
}

export async function createGlobalLabel(input: { name: string; color: string }): Promise<Label> {
  return (await api.post<Label>(`/admin/labels`, input)).data;
}

export async function updateGlobalLabel(
  labelId: string,
  input: { name?: string; color?: string },
): Promise<Label> {
  return (await api.patch<Label>(`/admin/labels/${labelId}`, input)).data;
}

export async function deleteGlobalLabel(labelId: string): Promise<void> {
  await api.delete(`/admin/labels/${labelId}`);
}

export async function attachLabel(
  teamId: string,
  projectId: string,
  taskId: string,
  labelId: string,
): Promise<TaskLabel> {
  return (
    await api.post<TaskLabel>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/labels`,
      { labelId },
    )
  ).data;
}

export async function detachLabel(
  teamId: string,
  projectId: string,
  taskId: string,
  labelId: string,
): Promise<void> {
  await api.delete(
    `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/labels/${labelId}`,
  );
}
