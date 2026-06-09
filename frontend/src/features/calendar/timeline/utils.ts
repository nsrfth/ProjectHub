import type { Task, TaskSubtask } from '@/features/tasks/api';
import type { ProjectCrossTeam } from '@/features/projects/api';
import type { TimelineRow } from './types';

const MS_PER_DAY = 86_400_000;

export function utcDayMs(iso: string): number {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function utcDayIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function daysBetween(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) / MS_PER_DAY);
}

export function addDaysMs(ms: number, days: number): number {
  return ms + days * MS_PER_DAY;
}

export function todayUtcMs(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

export function resolveTaskBarDates(task: Task): { start: string; end: string } | null {
  const start = task.startDate ?? task.plannedDate ?? task.dueDate;
  const end = task.dueDate ?? task.plannedDate ?? task.startDate;
  if (!start && !end) return null;
  const s = start ?? end!;
  const e = end ?? start!;
  return { start: s, end: e };
}

export function resolveSubtaskBarDates(sub: TaskSubtask): { start: string; end: string } | null {
  const start = sub.startDate;
  const end = sub.endDate;
  if (!start && !end) return null;
  const s = start ?? end!;
  const e = end ?? start!;
  return { start: s, end: e };
}

export function taskProgress(task: Task): number {
  if (task.status === 'DONE') return 100;
  if (task.subtasks.length === 0) return 0;
  const done = task.subtasks.filter((s) => s.done).length;
  return Math.round((done / task.subtasks.length) * 100);
}

export function statusBarColor(status: string, done: boolean): string {
  if (done || status === 'DONE') return '#10b981';
  switch (status) {
    case 'IN_PROGRESS':
      return '#3b82f6';
    case 'REVIEW':
      return '#f59e0b';
    default:
      return '#94a3b8';
  }
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function overlapsRange(
  barStart: string | null,
  barEnd: string | null,
  rangeStartMs: number,
  rangeEndMs: number,
): boolean {
  if (!barStart || !barEnd) return true;
  const s = utcDayMs(barStart);
  const e = utcDayMs(barEnd);
  return e >= rangeStartMs && s <= rangeEndMs;
}

interface BuildRowsInput {
  projects: ProjectCrossTeam[];
  tasksByProject: Map<string, Task[]>;
  teamColors: Map<string, string>;
  collapsedProjects: Set<string>;
  collapsedTasks: Set<string>;
}

export function buildTimelineRows(input: BuildRowsInput): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const sortedProjects = [...input.projects].sort((a, b) => a.name.localeCompare(b.name));

  for (const project of sortedProjects) {
    const tasks = input.tasksByProject.get(project.id) ?? [];
    if (tasks.length === 0) continue;

    const projectCollapsed = input.collapsedProjects.has(project.id);
    rows.push({
      id: `project:${project.id}`,
      kind: 'project',
      depth: 0,
      label: project.name,
      teamId: project.teamId,
      projectId: project.id,
      status: 'TODO',
      assigneeName: null,
      barStart: null,
      barEnd: null,
      progress: 0,
      done: false,
      teamColor: input.teamColors.get(project.teamId) ?? '#64748b',
      projectName: project.name,
      hasChildren: tasks.length > 0,
    });

    if (projectCollapsed) continue;

    const sortedTasks = [...tasks].sort((a, b) => a.position - b.position);
    for (const task of sortedTasks) {
      const bar = resolveTaskBarDates(task);
      const taskCollapsed = input.collapsedTasks.has(task.id);
      const hasSubtasks = task.subtasks.length > 0;

      rows.push({
        id: `task:${task.id}`,
        kind: 'task',
        depth: 1,
        label: task.title,
        teamId: task.teamId,
        projectId: project.id,
        taskId: task.id,
        status: task.status,
        assigneeName: task.assigneeId ? null : null,
        barStart: bar?.start ?? null,
        barEnd: bar?.end ?? null,
        progress: taskProgress(task),
        done: task.status === 'DONE',
        teamColor: input.teamColors.get(task.teamId) ?? '#64748b',
        projectName: project.name,
        hasChildren: hasSubtasks,
      });

      if (taskCollapsed || !hasSubtasks) continue;

      const sortedSubs = [...task.subtasks].sort((a, b) => a.position - b.position);
      for (const sub of sortedSubs) {
        const subBar = resolveSubtaskBarDates(sub);
        rows.push({
          id: `subtask:${sub.id}`,
          kind: 'subtask',
          depth: 2,
          label: sub.title,
          teamId: task.teamId,
          projectId: project.id,
          taskId: task.id,
          subtaskId: sub.id,
          parentTaskId: task.id,
          status: task.status,
          assigneeName: sub.assigneeName,
          barStart: subBar?.start ?? null,
          barEnd: subBar?.end ?? null,
          progress: sub.done ? 100 : 0,
          done: sub.done,
          teamColor: input.teamColors.get(task.teamId) ?? '#64748b',
          projectName: project.name,
          hasChildren: false,
        });
      }
    }
  }

  return rows;
}
