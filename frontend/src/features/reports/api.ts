import { api } from '@/lib/api';

export interface DoneTaskRow {
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  doneAt: string;
}

export interface DoneReport {
  windowDays: number;
  items: DoneTaskRow[];
}

export async function fetchDoneReport(teamId: string, days: number): Promise<DoneReport> {
  return (
    await api.get<DoneReport>(`/teams/${teamId}/reports/done`, { params: { days } })
  ).data;
}
