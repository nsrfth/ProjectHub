import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// v1.42: project Gantt aggregator. Returns every subtask in a project
// grouped by its parent task, along with cross-row summary counters.
//
// Visibility rule is enforced by the v1.39 requireProjectAccess
// middleware on the route — non-owners 404 before this service runs.
// We re-fetch the project to confirm it exists in the team (defence in
// depth) but otherwise trust the upstream gate.
//
// Wire shape is flat (not nested under tasks) so the SPA can drive
// virtualisation by row index. Each row carries parentTaskId/parentTaskTitle
// so the client groups visually without a second query.

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
  // Top-level summary block the SPA renders above the chart. All counts
  // are derived in one query so the client doesn't compute over the row
  // array (cheap, but the wire promise is the authority).
  summary: {
    totalTasks: number;
    totalSubtasks: number;
    scheduledSubtasks: number;
    unscheduledSubtasks: number;
    // Earliest start across all scheduled subtasks (ISO) and latest end.
    // Both null when the project has no scheduled subtasks at all.
    earliestStart: string | null;
    latestEnd: string | null;
  };
  // Every subtask in the project — scheduled and unscheduled. The SPA
  // typically filters to the scheduled set for the chart but renders
  // unscheduled separately as "needs scheduling".
  rows: GanttSubtaskRow[];
}

export class GanttService {
  async forProject(teamId: string, projectId: string): Promise<GanttReport> {
    // Defence-in-depth: confirm project exists in team. requireProjectAccess
    // upstream already enforced visibility; this catches direct service
    // invocations (tests, future scripts).
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project || project.teamId !== teamId) {
      throw Errors.notFound('Project not found');
    }

    // One query for the task → subtask graph. Soft-deleted tasks excluded
    // (trash). Subtasks are kept regardless of done — closed work still
    // belongs on a historical Gantt. Ordering by (task.position, subtask.position)
    // matches the rest of TaskHub's read paths.
    const tasks = await prisma.task.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        title: true,
        status: true,
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
            technicianId: true,
            technician: { select: { name: true } },
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
        if (s.startDate && (earliest === null || s.startDate < earliest)) {
          earliest = s.startDate;
        }
        if (s.endDate && (latest === null || s.endDate > latest)) {
          latest = s.endDate;
        }
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
          technicianId: s.technicianId,
          technicianName: s.technician?.name ?? null,
          done: s.done,
        });
      }
    }

    return {
      projectId,
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
  }
}
