import { api } from '@/lib/api';

// v2.0 (PMIS R4 — cost control): typed client for the per-project cost ledger
// (cost accounts, budget lines, commitments, expenses, actuals) + the summary.

export interface CurrencyBucket {
  currency: string;
  plannedMinor: string;
  committedMinor: string;
  actualMinor: string;
  remainingMinor: string;
  planned: string;
  committed: string;
  actual: string;
  remaining: string;
}

export interface ProjectCostSummary {
  projectId: string;
  reportingCurrency: string;
  byCurrency: CurrencyBucket[];
  base: CurrencyBucket & { currency: string; warnings: string[] };
}

export interface BudgetLine {
  id: string;
  projectId: string;
  costAccountId: string;
  costAccountCode: string | null;
  taskId: string | null;
  amountMinor: string;
  amount: string;
  currency: string;
  source: 'MIGRATED' | 'MANUAL';
  note: string | null;
  createdAt: string;
}

export interface ActualCostEntry {
  id: string;
  projectId: string;
  costAccountId: string | null;
  taskId: string | null;
  source: 'TIMESHEET' | 'EXPENSE' | 'INVOICE' | 'MANUAL';
  amountMinor: string;
  amount: string;
  currency: string;
  baseAmountMinor: string;
  baseAmount: string;
  baseCurrency: string;
  incurredOn: string;
  description: string | null;
  reversalOfId: string | null;
  createdAt: string;
}

const base = (teamId: string, projectId: string) => `/teams/${teamId}/projects/${projectId}/cost`;

export async function getCostSummary(teamId: string, projectId: string): Promise<ProjectCostSummary> {
  return (await api.get<ProjectCostSummary>(`${base(teamId, projectId)}/summary`)).data;
}
export async function listBudgetLines(teamId: string, projectId: string): Promise<BudgetLine[]> {
  return (await api.get<{ items: BudgetLine[] }>(`${base(teamId, projectId)}/budget-lines`)).data.items;
}
export async function createBudgetLine(
  teamId: string,
  projectId: string,
  input: { amountMinor: string; currency: string; note?: string; costAccountId?: string; taskId?: string },
): Promise<BudgetLine> {
  return (await api.post<BudgetLine>(`${base(teamId, projectId)}/budget-lines`, input)).data;
}
export async function deleteBudgetLine(teamId: string, projectId: string, id: string): Promise<void> {
  await api.delete(`${base(teamId, projectId)}/budget-lines/${id}`);
}
export async function listActuals(teamId: string, projectId: string): Promise<ActualCostEntry[]> {
  return (await api.get<{ items: ActualCostEntry[] }>(`${base(teamId, projectId)}/actuals`)).data.items;
}
export async function createActual(
  teamId: string,
  projectId: string,
  input: { amountMinor: string; currency: string; incurredOn: string; description?: string },
): Promise<ActualCostEntry> {
  return (await api.post<ActualCostEntry>(`${base(teamId, projectId)}/actuals`, input)).data;
}
export async function reverseActual(teamId: string, projectId: string, id: string): Promise<ActualCostEntry> {
  return (await api.post<ActualCostEntry>(`${base(teamId, projectId)}/actuals/${id}/reverse`, {})).data;
}
