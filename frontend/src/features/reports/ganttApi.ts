import { api } from '@/lib/api';

// v1.42: project Gantt report client. Mirrors GanttReport in
// backend/src/services/ganttService.ts.

export interface GanttSubtaskRow {
  id: string;
  taskId: string;
  parentTaskTitle: string;
  parentTaskStatus: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  technicianId: string | null;
  technicianName: string | null;
  done: boolean;
}

export interface GanttReport {
  projectId: string;
  summary: {
    totalTasks: number;
    totalSubtasks: number;
    scheduledSubtasks: number;
    unscheduledSubtasks: number;
    earliestStart: string | null;
    latestEnd: string | null;
  };
  rows: GanttSubtaskRow[];
}

export async function fetchGantt(teamId: string, projectId: string): Promise<GanttReport> {
  return (
    await api.get<GanttReport>(
      `/teams/${teamId}/projects/${projectId}/reports/gantt`,
    )
  ).data;
}
