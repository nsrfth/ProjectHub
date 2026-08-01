import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { readSchedulingSettings } from '../lib/schedulingSettings.js';
import { WorkingDayCalendar } from '../lib/workingDays.js';
import { deriveWbsCodes } from '../lib/wbs.js';
import {
  classifyFloat,
  computeCpm,
  getCachedCpm,
  setCachedCpm,
  DEFAULT_NEAR_CRITICAL_DAYS,
  type CpmExclusionReason,
  type FloatStatus,
} from '../lib/cpm.js';

// v2.23.0 (PMIS R5 supplement): CPM Schedule Analysis report.
//
// Distinct from the Gantt bar chart: an activity-level tabular analysis with
// early/late dates, total + free float, float banding, and the driving
// predecessor — the numbers a planner actually reviews. The Gantt endpoint
// keeps its own payload (which carries the full subtask row set this report
// does not need) and its critical-path overlay unchanged.
//
// Basis is PLANNED in v1: the network is computed from planned dates only —
// no progress override and no retained logic. `basis` is carried in the
// response so a future 'PROGRESS' mode is purely additive.

export const MAX_NEAR_CRITICAL_DAYS = 30;

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

export class CpmReportService {
  async forProject(
    teamId: string,
    projectId: string,
    opts: { nearCriticalDays?: number } = {},
  ): Promise<CpmReport> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true, scheduleVersion: true },
    });
    if (!project || project.teamId !== teamId) {
      throw Errors.notFound('Project not found');
    }

    const nearCriticalDays = Math.min(
      Math.max(opts.nearCriticalDays ?? DEFAULT_NEAR_CRITICAL_DAYS, 0),
      MAX_NEAR_CRITICAL_DAYS,
    );

    const scheduling = await readSchedulingSettings();
    const cal = scheduling.workingDaysOnly ? await WorkingDayCalendar.load() : null;

    const tasks = await prisma.task.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        title: true,
        parentId: true,
        wbsOrder: true,
        createdAt: true,
        startDate: true,
        dueDate: true,
        isMilestone: true,
        _count: { select: { children: { where: { deletedAt: null } } } },
      },
    });

    // The cached artifact is keyed by (projectId, scheduleVersion) only, so it
    // is shared with the Gantt overlay. `nearCriticalDays` deliberately does
    // NOT enter the key: it bands float, it does not change it — the status is
    // re-derived per request below.
    let cpm = getCachedCpm(projectId, project.scheduleVersion);
    if (!cpm) {
      const edges = await prisma.taskDependency.findMany({
        where: { teamId, task: { projectId, deletedAt: null } },
        select: {
          id: true,
          taskId: true,
          dependsOnId: true,
          type: true,
          lag: true,
          lagUnit: true,
          calendarMode: true,
        },
      });
      cpm = computeCpm(
        tasks.map((t) => ({
          id: t.id,
          startDate: t.startDate,
          dueDate: t.dueDate,
          isMilestone: t.isMilestone,
          isSummary: t._count.children > 0,
        })),
        edges,
        cal,
        project.scheduleVersion,
      );
      setCachedCpm(projectId, cpm);
    }

    const codes = deriveWbsCodes(tasks);
    const titleOf = new Map(tasks.map((t) => [t.id, t.title]));
    const milestoneOf = new Map(tasks.map((t) => [t.id, t.isMilestone]));

    const byFloatStatus = { negative: 0, critical: 0, nearCritical: 0, normal: 0 };
    const rows: CpmReportRow[] = cpm.tasks.map((t) => {
      const floatStatus = classifyFloat(t.totalFloatDays, nearCriticalDays);
      if (floatStatus === 'NEGATIVE') byFloatStatus.negative++;
      else if (floatStatus === 'CRITICAL') byFloatStatus.critical++;
      else if (floatStatus === 'NEAR_CRITICAL') byFloatStatus.nearCritical++;
      else byFloatStatus.normal++;
      return {
        taskId: t.taskId,
        wbsCode: codes.get(t.taskId) ?? null,
        title: titleOf.get(t.taskId) ?? '',
        isMilestone: milestoneOf.get(t.taskId) ?? false,
        durationDays: t.durationDays,
        earlyStart: t.earlyStart,
        earlyFinish: t.earlyFinish,
        lateStart: t.lateStart,
        lateFinish: t.lateFinish,
        totalFloatDays: t.totalFloatDays,
        freeFloatDays: t.freeFloatDays,
        floatStatus,
        drivingPredecessorId: t.drivingPredecessorId,
      };
    });

    // Sort by WBS code so the table reads like the work breakdown, not like
    // whatever `position` happens to be. Codes are dotted decimals — compare
    // segment by segment so 1.10 sorts after 1.9, not before it.
    rows.sort((a, b) => compareWbsCodes(a.wbsCode, b.wbsCode));

    const excluded: CpmReportExclusion[] = cpm.excluded.map((x) => ({
      taskId: x.taskId,
      title: titleOf.get(x.taskId) ?? '',
      reason: x.reason,
    }));

    return {
      projectId,
      scheduleVersion: cpm.scheduleVersion,
      basis: 'PLANNED',
      workingDaysOnly: scheduling.workingDaysOnly,
      nearCriticalDays,
      summary: {
        activityCount: rows.length,
        excludedCount: excluded.length,
        projectStart: cpm.projectStart,
        projectFinish: cpm.projectFinish,
        criticalPathDurationDays: cpm.criticalPathDurationDays,
        byFloatStatus,
      },
      criticalPath: cpm.criticalPathOrdered,
      rows,
      excluded,
    };
  }
}

/** Dotted-decimal outline comparison: 1.9 < 1.10. Unnumbered rows sort last. */
export function compareWbsCodes(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = Number(as[i] ?? -1);
    const bv = Number(bs[i] ?? -1);
    if (av !== bv) return av - bv;
  }
  return 0;
}
