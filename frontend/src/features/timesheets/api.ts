import { api } from '@/lib/api';

// v2.0 (PMIS R4 — time tracking): typed client for rate cards, time entries,
// and timesheet periods. Money is decimal strings on the wire.

export type TimesheetStatus = 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'REOPENED';

export interface RateCard {
  id: string;
  scope: 'USER' | 'ROLE';
  userId: string | null;
  userName: string | null;
  role: 'MANAGER' | 'MEMBER' | null;
  currency: string;
  costRateMinor: string;
  costRate: string;
  billRateMinor: string | null;
  billRate: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface TimeEntry {
  id: string;
  userId: string;
  userName: string | null;
  projectId: string;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  periodId: string | null;
  status: TimesheetStatus;
  date: string;
  minutes: number;
  hours: string;
  billable: boolean;
  note: string | null;
  costRateMinorSnapshot: string | null;
  currencySnapshot: string | null;
  createdAt: string;
}

export interface TimesheetPeriod {
  id: string;
  userId: string;
  userName: string | null;
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  submittedAt: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  totalMinutes: number;
  entryCount: number;
  createdAt: string;
}

export async function listRateCards(teamId: string): Promise<RateCard[]> {
  return (await api.get<{ items: RateCard[] }>(`/teams/${teamId}/rate-cards`)).data.items;
}
export async function createRateCard(
  teamId: string,
  input: {
    scope: 'USER' | 'ROLE';
    userId?: string;
    role?: 'MANAGER' | 'MEMBER';
    currency: string;
    costRateMinor: string;
    billRateMinor?: string;
    effectiveFrom: string;
    effectiveTo?: string;
  },
): Promise<RateCard> {
  return (await api.post<RateCard>(`/teams/${teamId}/rate-cards`, input)).data;
}
export async function deleteRateCard(teamId: string, id: string): Promise<void> {
  await api.delete(`/teams/${teamId}/rate-cards/${id}`);
}

export async function listTimeEntries(
  teamId: string,
  params: { userId?: string; projectId?: string; from?: string; to?: string } = {},
): Promise<TimeEntry[]> {
  return (await api.get<{ items: TimeEntry[] }>(`/teams/${teamId}/time-entries`, { params })).data.items;
}
export async function createTimeEntry(
  teamId: string,
  input: { projectId: string; taskId?: string; date: string; minutes: number; billable?: boolean; note?: string },
): Promise<TimeEntry> {
  return (await api.post<TimeEntry>(`/teams/${teamId}/time-entries`, input)).data;
}
export async function deleteTimeEntry(teamId: string, id: string): Promise<void> {
  await api.delete(`/teams/${teamId}/time-entries/${id}`);
}

export async function listPeriods(teamId: string, userId?: string): Promise<TimesheetPeriod[]> {
  return (await api.get<{ items: TimesheetPeriod[] }>(`/teams/${teamId}/timesheets`, { params: { userId } })).data.items;
}
export async function ensurePeriod(teamId: string, periodStart: string, periodEnd: string): Promise<TimesheetPeriod> {
  return (await api.post<TimesheetPeriod>(`/teams/${teamId}/timesheets`, { periodStart, periodEnd })).data;
}
export async function submitPeriod(teamId: string, id: string): Promise<TimesheetPeriod> {
  return (await api.post<TimesheetPeriod>(`/teams/${teamId}/timesheets/${id}/submit`, {})).data;
}
export async function approvePeriod(teamId: string, id: string): Promise<TimesheetPeriod> {
  return (await api.post<TimesheetPeriod>(`/teams/${teamId}/timesheets/${id}/approve`, {})).data;
}
export async function rejectPeriod(teamId: string, id: string, reason: string): Promise<TimesheetPeriod> {
  return (await api.post<TimesheetPeriod>(`/teams/${teamId}/timesheets/${id}/reject`, { reason })).data;
}
export async function reopenPeriod(teamId: string, id: string): Promise<TimesheetPeriod> {
  return (await api.post<TimesheetPeriod>(`/teams/${teamId}/timesheets/${id}/reopen`, {})).data;
}
