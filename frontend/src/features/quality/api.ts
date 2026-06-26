import { api } from '@/lib/api';

// v2.5 (PMIS R9 — quality): typed client for the NCR (non-conformance report) register.
// Mirrors backend/src/schemas/lifecycle.ts ncrResponse shape.

export type NcrSeverity = 'MINOR' | 'MAJOR' | 'CRITICAL';
export type NcrDisposition = 'USE_AS_IS' | 'REWORK' | 'REJECT' | 'CONCESSION';

export interface Ncr {
  id: string;
  teamId: string;
  projectId: string;
  reference: string;
  title: string;
  description: string | null;
  severity: NcrSeverity;
  disposition: NcrDisposition | null;
  correctiveTaskId: string | null;
  closedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNcrInput {
  title: string;
  description?: string | null;
  severity?: NcrSeverity;
}
export interface UpdateNcrInput {
  title?: string;
  description?: string | null;
  severity?: NcrSeverity;
  disposition?: NcrDisposition | null;
  correctiveTaskId?: string | null;
}

const base = (teamId: string, projectId: string): string =>
  `/teams/${teamId}/projects/${projectId}/ncrs`;

export async function listNcrs(teamId: string, projectId: string): Promise<Ncr[]> {
  return (await api.get<{ items: Ncr[] }>(base(teamId, projectId))).data.items;
}
export async function createNcr(
  teamId: string, projectId: string, input: CreateNcrInput,
): Promise<Ncr> {
  return (await api.post<Ncr>(base(teamId, projectId), input)).data;
}
export async function updateNcr(
  teamId: string, projectId: string, id: string, input: UpdateNcrInput,
): Promise<Ncr> {
  return (await api.patch<Ncr>(`${base(teamId, projectId)}/${id}`, input)).data;
}
export async function closeNcr(teamId: string, projectId: string, id: string): Promise<void> {
  await api.post(`${base(teamId, projectId)}/${id}/close`, {});
}
export async function deleteNcr(teamId: string, projectId: string, id: string): Promise<void> {
  await api.delete(`${base(teamId, projectId)}/${id}`);
}
