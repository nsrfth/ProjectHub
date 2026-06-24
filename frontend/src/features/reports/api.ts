import { api } from '@/lib/api';

export interface DoneTaskRow {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  completedAt: string;
}

export interface DoneReport {
  windowDays: number;
  items: DoneTaskRow[];
}

export async function fetchDoneReport(teamId: string, days: number): Promise<DoneReport> {
  return (await api.get<DoneReport>(`/teams/${teamId}/reports/done`, { params: { days } })).data;
}

export interface WorkloadRow {
  assigneeId: string | null;
  assigneeName: string | null;
  total: number;
  byStatus: { TODO: number; IN_PROGRESS: number; REVIEW: number; PENDING_APPROVAL: number };
}

export async function fetchWorkload(teamId: string): Promise<{ items: WorkloadRow[] }> {
  return (await api.get<{ items: WorkloadRow[] }>(`/teams/${teamId}/reports/workload`)).data;
}

export type WorkloadWindow = 'all' | 'overdue' | 'this_week' | 'next_week';

export interface WorkloadDueBucketCounts {
  overdue: number;
  this_week: number;
  next_week: number;
  later: number;
  no_due: number;
}

export interface WorkloadDetailRow {
  userId: string | null;
  name: string | null;
  openByStatus: { TODO: number; IN_PROGRESS: number; REVIEW: number };
  byDueBucket: WorkloadDueBucketCounts;
  total: number;
  weightedTotal: number;
}

export interface WorkloadDetailReport {
  window: WorkloadWindow;
  weighted: boolean;
  projectId: string | null;
  items: WorkloadDetailRow[];
}

export async function fetchWorkloadDetail(
  teamId: string,
  params?: {
    projectId?: string;
    window?: WorkloadWindow;
    weighted?: boolean;
  },
): Promise<WorkloadDetailReport> {
  return (
    await api.get<WorkloadDetailReport>(`/teams/${teamId}/reports/workload/detail`, {
      params: {
        projectId: params?.projectId,
        window: params?.window ?? 'all',
        weighted: params?.weighted ? 'true' : 'false',
      },
    })
  ).data;
}

export interface OverdueTaskRow {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  status: 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string;
  daysOverdue: number;
}

export async function fetchOverdue(teamId: string): Promise<{ items: OverdueTaskRow[] }> {
  return (await api.get<{ items: OverdueTaskRow[] }>(`/teams/${teamId}/reports/overdue`)).data;
}

export interface SummaryReport {
  doneLast7Days: number;
  overdueCount: number;
  openCount: number;
  byStatus: {
    TODO: number;
    IN_PROGRESS: number;
    REVIEW: number;
    PENDING_APPROVAL: number;
    DONE: number;
  };
}

export async function fetchSummary(teamId: string): Promise<SummaryReport> {
  return (await api.get<SummaryReport>(`/teams/${teamId}/reports/summary`)).data;
}

export interface TimelinessReport {
  windowDays: number;
  evaluatedCount: number;
  // 0..1; 0 when no tasks have both plannedDate + completedAt in window.
  onTimeRate: number;
  // Days; positive = late, negative = early.
  avgVarianceDays: number;
  behindPlanCount: number;
}

// v1.31: dashboard feeds.
export interface UpcomingTaskRow {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  status: 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  dueDate: string;
  daysUntil: number;
}

export async function fetchUpcoming(
  teamId: string,
  days = 7,
): Promise<{ windowDays: number; items: UpcomingTaskRow[] }> {
  return (
    await api.get<{ windowDays: number; items: UpcomingTaskRow[] }>(
      `/teams/${teamId}/reports/upcoming`,
      { params: { days } },
    )
  ).data;
}

export interface TeamActivityRow {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export async function fetchTeamActivity(
  teamId: string,
  limit = 20,
): Promise<{ items: TeamActivityRow[] }> {
  return (
    await api.get<{ items: TeamActivityRow[] }>(`/teams/${teamId}/reports/activity`, {
      params: { limit },
    })
  ).data;
}

export async function fetchTimeliness(
  teamId: string,
  days: number,
): Promise<TimelinessReport> {
  return (
    await api.get<TimelinessReport>(`/teams/${teamId}/reports/timeliness`, {
      params: { days },
    })
  ).data;
}

export interface BudgetProjectRow {
  projectId: string;
  projectName: string;
  currency: 'IRR' | 'EUR' | 'USD';
  hasBudget: boolean;
  plannedBudget: string | null;
}

export interface BudgetCurrencyRollup {
  currency: 'IRR' | 'EUR' | 'USD';
  projectCount: number;
  projectsWithBudget: number;
  totalPlanned: string | null;
}

export interface BudgetReport {
  projects: BudgetProjectRow[];
  rollupByCurrency: BudgetCurrencyRollup[];
}

export async function fetchBudgetReport(teamId: string): Promise<BudgetReport> {
  return (await api.get<BudgetReport>(`/teams/${teamId}/reports/budget`)).data;
}

// CSV download. We can't just use a plain anchor href because the API needs a
// Bearer header — fetch via axios with responseType=blob, then trigger a
// download via a temporary object URL. Filename comes from the
// Content-Disposition header when present (falls back to the supplied default).
export async function downloadReportCsv(
  teamId: string,
  report: 'done' | 'workload' | 'overdue' | 'timeliness' | 'budget',
  fallbackName: string,
  params?: Record<string, string | number>,
): Promise<void> {
  const res = await api.get<Blob>(`/teams/${teamId}/reports/${report}.csv`, {
    params,
    responseType: 'blob',
  });
  // Parse Content-Disposition for a filename. Format from the server:
  //   attachment; filename="tasks-done-7d-2026-05-24.csv"
  const cd = (res.headers['content-disposition'] ?? '') as string;
  const match = /filename="?([^"]+)"?/i.exec(cd);
  const filename = match?.[1] ?? `${fallbackName}.csv`;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
