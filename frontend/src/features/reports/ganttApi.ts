import { api } from '@/lib/api';

// v1.42: project Gantt report client. v2.1 (PMIS R5): optional schedule overlay
// (?include=criticalPath,baseline,milestones).

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
  responsibleId: string | null;
  responsibleName: string | null;
  done: boolean;
  workingDayCount: number | null;
}

export interface GanttCpmBlock {
  taskId: string;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  totalFloatDays: number;
  isCritical: boolean;
}

export interface GanttTaskScheduleRow {
  id: string;
  title: string;
  startDate: string | null;
  dueDate: string | null;
  isMilestone: boolean;
  milestoneKind: string | null;
  cpm?: GanttCpmBlock;
  baseline?: { start: string | null; end: string | null };
}

export interface GanttLinkRow {
  id: string;
  taskId: string;
  dependsOnId: string;
  type: string;
  lag: number;
  lagUnit: string;
  calendarMode: string;
  isCritical: boolean;
}

export interface GanttReport {
  projectId: string;
  scheduleVersion?: number;
  workingDaysOnly: boolean;
  summary: {
    totalTasks: number;
    totalSubtasks: number;
    scheduledSubtasks: number;
    unscheduledSubtasks: number;
    earliestStart: string | null;
    latestEnd: string | null;
  };
  rows: GanttSubtaskRow[];
  tasks?: GanttTaskScheduleRow[];
  links?: GanttLinkRow[];
  criticalChain?: string[];
}

export async function fetchGantt(
  teamId: string,
  projectId: string,
  include?: string,
): Promise<GanttReport> {
  return (
    await api.get<GanttReport>(`/teams/${teamId}/projects/${projectId}/reports/gantt`, {
      params: include ? { include } : undefined,
    })
  ).data;
}

export interface ProjectBaseline {
  id: string;
  name: string;
  source: 'MANUAL' | 'CHANGE_REQUEST';
  isCurrent: boolean;
  capturedAt: string;
  entryCount: number;
}

export async function captureBaseline(
  teamId: string,
  projectId: string,
  name: string,
): Promise<ProjectBaseline> {
  return (
    await api.post<ProjectBaseline>(`/teams/${teamId}/projects/${projectId}/baselines`, { name })
  ).data;
}
