import { api } from '@/lib/api';

// v1.81: one-page per-project status report client. Mirrors
// ProjectStatusReport in backend/src/services/projectStatusService.ts.

export interface ProjectStatusReport {
  projectId: string;
  name: string;
  code: string | null;
  description: string | null;
  status: 'ACTIVE' | 'ON_HOLD' | 'ARCHIVED';
  ragStatus: 'GREEN' | 'AMBER' | 'RED';
  ragReason: string | null;
  healthUpdatedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  ownerName: string | null;
  accountableName: string | null;
  plannedBudget: string | null;
  budgetCurrency: 'IRR' | 'EUR' | 'USD';
  taskCounts: {
    todo: number;
    inProgress: number;
    review: number;
    done: number;
    total: number;
  };
  overdueCount: number;
  percentComplete: number;
  risks: { open: number; total: number } | null;
  changeRequests: { pending: number; approved: number; total: number } | null;
  costSummary: {
    plannedBudgetLines: string;
    committed: string;
    actual: string;
    currency: string;
  } | null;
}

export async function fetchProjectStatus(
  teamId: string,
  projectId: string,
): Promise<ProjectStatusReport> {
  return (
    await api.get<ProjectStatusReport>(
      `/teams/${teamId}/projects/${projectId}/reports/status`,
    )
  ).data;
}
