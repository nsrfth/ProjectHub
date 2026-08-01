import { api } from '@/lib/api';

// v2.23.0 (PMIS R5 supplement): CPM Schedule Analysis report client.
// Mirrors ganttApi's shape. The Gantt endpoint keeps its own critical-path
// overlay; this is the tabular activity-level analysis.

export type FloatStatus = 'NEGATIVE' | 'CRITICAL' | 'NEAR_CRITICAL' | 'NORMAL';
export type CpmExclusionReason = 'NO_DATES' | 'IS_SUMMARY' | 'ORPHANED_EDGE';

export interface CpmReportRow {
  taskId: string;
  wbsCode: string | null;
  title: string;
  isMilestone: boolean;
  durationDays: number;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  totalFloatDays: number;
  freeFloatDays: number;
  floatStatus: FloatStatus;
  drivingPredecessorId: string | null;
}

export interface CpmReportExclusion {
  taskId: string;
  title: string;
  reason: CpmExclusionReason;
}

export interface CpmReport {
  projectId: string;
  scheduleVersion: number;
  basis: 'PLANNED';
  workingDaysOnly: boolean;
  nearCriticalDays: number;
  summary: {
    activityCount: number;
    excludedCount: number;
    projectStart: string | null;
    projectFinish: string | null;
    criticalPathDurationDays: number;
    byFloatStatus: { negative: number; critical: number; nearCritical: number; normal: number };
  };
  criticalPath: string[];
  rows: CpmReportRow[];
  excluded: CpmReportExclusion[];
}

export const MAX_NEAR_CRITICAL_DAYS = 30;

export async function fetchCpmReport(
  teamId: string,
  projectId: string,
  nearCriticalDays?: number,
): Promise<CpmReport> {
  return (
    await api.get<CpmReport>(`/teams/${teamId}/projects/${projectId}/reports/cpm`, {
      params: nearCriticalDays === undefined ? undefined : { nearCriticalDays },
    })
  ).data;
}

/** Downloads the CSV through the authenticated axios client (the export route
 *  needs the bearer token, so a bare <a href> would 401). */
export async function downloadCpmCsv(
  teamId: string,
  projectId: string,
  nearCriticalDays?: number,
): Promise<Blob> {
  return (
    await api.get<Blob>(`/teams/${teamId}/projects/${projectId}/reports/cpm.csv`, {
      params: nearCriticalDays === undefined ? undefined : { nearCriticalDays },
      responseType: 'blob',
    })
  ).data;
}
