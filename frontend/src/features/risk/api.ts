import { api } from '@/lib/api';

// v2.5 (PMIS R9 — risk register): typed client for the per-project risk register.
// Mirrors the backend `riskResponse` shape (backend/src/schemas/lifecycle.ts).

export type RiskResponseStrategy = 'ACCEPT' | 'AVOID' | 'MITIGATE' | 'TRANSFER';

export interface Risk {
  id: string;
  teamId: string;
  projectId: string;
  reference: string;
  title: string;
  description: string | null;
  probability: number;
  impact: number;
  score: number;
  response: RiskResponseStrategy;
  mitigationPlan: string | null;
  ownerId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  closedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRiskInput {
  title: string;
  description?: string | null;
  probability: number;
  impact: number;
  response?: RiskResponseStrategy;
  mitigationPlan?: string | null;
  ownerId?: string | null;
  dueDate?: string | null;
}
export type UpdateRiskInput = Partial<CreateRiskInput>;

const base = (teamId: string, projectId: string): string =>
  `/teams/${teamId}/projects/${projectId}/risks`;

export async function listRisks(teamId: string, projectId: string): Promise<Risk[]> {
  return (await api.get<{ items: Risk[] }>(base(teamId, projectId))).data.items;
}
export async function createRisk(
  teamId: string,
  projectId: string,
  input: CreateRiskInput,
): Promise<Risk> {
  return (await api.post<Risk>(base(teamId, projectId), input)).data;
}
export async function updateRisk(
  teamId: string,
  projectId: string,
  id: string,
  input: UpdateRiskInput,
): Promise<Risk> {
  return (await api.patch<Risk>(`${base(teamId, projectId)}/${id}`, input)).data;
}
export async function closeRisk(teamId: string, projectId: string, id: string): Promise<void> {
  await api.post(`${base(teamId, projectId)}/${id}/close`, {});
}
export async function deleteRisk(teamId: string, projectId: string, id: string): Promise<void> {
  await api.delete(`${base(teamId, projectId)}/${id}`);
}
