import { api } from '@/lib/api';

export interface CalendarTask {
  id: string;
  title: string;
  status: 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  dueDate: string | null;
  plannedDate: string | null;
  completedAt: string | null;
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  teamColor: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
}

export async function fetchCalendar(
  teamId: string,
  opts: { since: string; until: string; field?: 'due' | 'planned' },
): Promise<{ items: CalendarTask[] }> {
  return (
    await api.get<{ items: CalendarTask[] }>(`/teams/${teamId}/calendar`, {
      params: {
        since: opts.since,
        until: opts.until,
        field: opts.field ?? 'due',
      },
    })
  ).data;
}
