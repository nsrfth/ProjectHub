import { api } from '@/lib/api';

// v2.5 (PMIS R9 — change control): typed client for change requests.
// Mirrors backend/src/schemas/lifecycle.ts changeRequestResponse.

export type CRStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'APPLIED';
export type BudgetCurrency = 'IRR' | 'USD' | 'EUR';

export interface ChangeRequest {
  id: string;
  teamId: string;
  projectId: string;
  reference: string;
  title: string;
  description: string | null;
  status: CRStatus;
  scheduleDeltaDays: number | null;
  costImpactMinor: number | null;
  costCurrency: BudgetCurrency | null;
  submittedById: string | null;
  submittedAt: string | null;
  decidedById: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  appliedBaselineId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCRInput {
  title: string;
  description?: string | null;
  scheduleDeltaDays?: number | null;
  costImpactMinor?: number | null;
  costCurrency?: BudgetCurrency | null;
}
export type UpdateCRInput = Partial<CreateCRInput>;

export interface DecideCRInput {
  decision: 'APPROVED' | 'REJECTED';
  rejectionReason?: string | null;
}

const base = (teamId: string, projectId: string): string =>
  `/teams/${teamId}/projects/${projectId}/change-requests`;

export async function listChangeRequests(teamId: string, projectId: string): Promise<ChangeRequest[]> {
  return (await api.get<{ items: ChangeRequest[] }>(base(teamId, projectId))).data.items;
}
export async function createChangeRequest(
  teamId: string, projectId: string, input: CreateCRInput,
): Promise<ChangeRequest> {
  return (await api.post<ChangeRequest>(base(teamId, projectId), input)).data;
}
export async function submitChangeRequest(
  teamId: string, projectId: string, id: string,
): Promise<ChangeRequest> {
  return (await api.post<ChangeRequest>(`${base(teamId, projectId)}/${id}/submit`, {})).data;
}
export async function decideChangeRequest(
  teamId: string, projectId: string, id: string, input: DecideCRInput,
): Promise<ChangeRequest> {
  return (await api.post<ChangeRequest>(`${base(teamId, projectId)}/${id}/decide`, input)).data;
}
export async function applyChangeRequest(
  teamId: string, projectId: string, id: string,
): Promise<ChangeRequest> {
  return (await api.post<ChangeRequest>(`${base(teamId, projectId)}/${id}/apply`, {})).data;
}
export async function deleteChangeRequest(
  teamId: string, projectId: string, id: string,
): Promise<void> {
  await api.delete(`${base(teamId, projectId)}/${id}`);
}
