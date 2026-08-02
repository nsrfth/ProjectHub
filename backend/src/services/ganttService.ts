import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { readSchedulingSettings } from '../lib/schedulingSettings.js';
import { WorkingDayCalendar } from '../lib/workingDays.js';
import {
  computeCpm,
  getCachedCpm,
  setCachedCpm,
  type CpmTaskResult,
} from '../lib/cpm.js';
import { ProjectBaselinesService } from './projectBaselinesService.js';

// v1.42 + v2.1 (PMIS R5): project Gantt — legacy subtask rows unchanged; optional
// task-level schedule overlay (milestones, CPM, baseline bars) via ?include=.

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

export interface GanttTaskScheduleRow {
  id: string;
  title: string;
  startDate: string | null;
  dueDate: string | null;
  isMilestone: boolean;
  milestoneKind: string | null;
  cpm?: CpmTaskResult;
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
  summary: {
    totalTasks: number;
    totalSubtasks: number;
    scheduledSubtasks: number;
    unscheduledSubtasks: number;
    earliestStart: string | null;
    latestEnd: string | null;
  };
  workingDaysOnly: boolean;
  rows: GanttSubtaskRow[];
  tasks?: GanttTaskScheduleRow[];
  links?: GanttLinkRow[];
  criticalChain?: string[];
}

export interface GanttInclude {
  criticalPath?: boolean;
  baseline?: boolean;
  milestones?: boolean;
}

export class GanttService {
  private readonly baselines = new ProjectBaselinesService();

  async forProject(
    teamId: string,
    projectId: string,
    include: GanttInclude = {},
  ): Promise<GanttReport> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true, scheduleVersion: true },
    });
    if (!project || project.teamId !== teamId) {
      throw Errors.notFound('Project not found');
    }

    const scheduling = await readSchedulingSettings();
    const cal = scheduling.workingDaysOnly ? await WorkingDayCalendar.load() : null;

    const tasks = await prisma.task.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        title: true,
        status: true,
        startDate: true,
        dueDate: true,
        isMilestone: true,
        milestoneKind: true,
        _count: { select: { children: { where: { deletedAt: null } } } },
        subtasks: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            taskId: true,
            title: true,
            done: true,
            startDate: true,
            endDate: true,
            assigneeId: true,
            assignee: { select: { name: true } },
            responsibleId: true,
            responsible: { select: { name: true } },
          },
        },
      },
    });

    const rows: GanttSubtaskRow[] = [];
    let scheduledCount = 0;
    let earliest: Date | null = null;
    let latest: Date | null = null;

    for (const t of tasks) {
      for (const s of t.subtasks) {
        const isScheduled = s.startDate !== null && s.endDate !== null;
        if (isScheduled) scheduledCount++;
        if (s.startDate && (earliest === null || s.startDate < earliest)) earliest = s.startDate;
        if (s.endDate && (latest === null || s.endDate > latest)) latest = s.endDate;
        rows.push({
          id: s.id,
          taskId: s.taskId,
          parentTaskTitle: t.title,
          parentTaskStatus: t.status,
          title: s.title,
          startDate: s.startDate ? s.startDate.toISOString() : null,
          endDate: s.endDate ? s.endDate.toISOString() : null,
          assigneeId: s.assigneeId,
          assigneeName: s.assignee?.name ?? null,
          responsibleId: s.responsibleId,
          responsibleName: s.responsible?.name ?? null,
          done: s.done,
          workingDayCount:
            cal && isScheduled && s.startDate && s.endDate
              ? cal.countWorkingDaysInclusive(s.startDate, s.endDate)
              : null,
        });
      }
    }

    const base: GanttReport = {
      projectId,
      scheduleVersion: project.scheduleVersion,
      workingDaysOnly: scheduling.workingDaysOnly,
      summary: {
        totalTasks: tasks.length,
        totalSubtasks: rows.length,
        scheduledSubtasks: scheduledCount,
        unscheduledSubtasks: rows.length - scheduledCount,
        earliestStart: earliest ? earliest.toISOString() : null,
        latestEnd: latest ? latest.toISOString() : null,
      },
      rows,
    };

    // v2.23.1: a project's task-level schedule is its own schedule, not an
    // optional overlay. It used to be returned only when ?include= asked for
    // criticalPath/baseline/milestones, which left a project whose subtasks
    // carry no dates with nothing to draw at all. The rows are always returned
    // now (the tasks are already loaded above, so this costs no extra query);
    // CPM, baseline and milestone *decorations* stay behind ?include=.
    const isScheduledTask = (t: (typeof tasks)[number]): boolean =>
      t.isMilestone ? !!(t.startDate ?? t.dueDate) : !!(t.startDate && t.dueDate);

    const baselineMap = include.baseline
      ? await this.baselines.baselineBarsForProject(projectId)
      : new Map<string, { start: string | null; end: string | null }>();

    let cpmByTask = new Map<string, CpmTaskResult>();
    let criticalEdgeIds = new Set<string>();
    if (include.criticalPath) {
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
      cpmByTask = new Map(cpm.tasks.map((x) => [x.taskId, x]));
      criticalEdgeIds = new Set(cpm.criticalEdgeIds);
      base.criticalChain = cpm.criticalChain;
    }

    const scheduleTasks = tasks.filter((t) => {
      if (isScheduledTask(t)) return true;
      if (include.milestones && t.isMilestone) return true;
      if (include.criticalPath && cpmByTask.has(t.id)) return true;
      if (include.baseline && baselineMap.has(t.id)) return true;
      return include.criticalPath && (t.startDate || t.dueDate);
    });

    base.tasks = scheduleTasks.map((t) => ({
      id: t.id,
      title: t.title,
      startDate: t.startDate ? t.startDate.toISOString() : null,
      dueDate: t.dueDate ? t.dueDate.toISOString() : null,
      isMilestone: t.isMilestone,
      milestoneKind: t.milestoneKind,
      ...(cpmByTask.has(t.id) ? { cpm: cpmByTask.get(t.id) } : {}),
      ...(baselineMap.has(t.id) ? { baseline: baselineMap.get(t.id) } : {}),
    }));

    if (include.criticalPath) {
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
      base.links = edges
        .filter((e) => e.type !== 'RELATES_TO')
        .map((e) => ({
          id: e.id,
          taskId: e.taskId,
          dependsOnId: e.dependsOnId,
          type: e.type,
          lag: e.lag,
          lagUnit: e.lagUnit,
          calendarMode: e.calendarMode,
          isCritical: criticalEdgeIds.has(e.id),
        }));
    }

    return base;
  }
}
