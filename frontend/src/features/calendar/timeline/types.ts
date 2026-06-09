import type { TaskStatus } from '@/features/tasks/api';

export type TimelineZoom = 'day' | 'week' | 'month';

export type TimelineRowKind = 'project' | 'task' | 'subtask';

/** Flat row rendered in the sidebar + chart. */
export interface TimelineRow {
  id: string;
  kind: TimelineRowKind;
  depth: number;
  label: string;
  teamId: string;
  projectId: string;
  taskId?: string;
  subtaskId?: string;
  status: TaskStatus;
  assigneeName: string | null;
  /** Resolved bar start (ISO UTC midnight). Null = unscheduled. */
  barStart: string | null;
  /** Resolved bar end (ISO UTC midnight). Null = unscheduled. */
  barEnd: string | null;
  progress: number;
  done: boolean;
  teamColor: string;
  projectName: string;
  hasChildren: boolean;
  /** Parent task id when kind === 'subtask'. */
  parentTaskId?: string;
}

/** Future-ready dependency edge for SVG connector layer (phase 2). */
export interface TimelineDependencyEdge {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  type: 'FINISH_TO_START' | 'START_TO_START' | 'RELATES_TO';
}

export interface TimelineFilters {
  projectId: string;
  assigneeId: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  search: string;
}

export type BarDragMode = 'move' | 'resize-start' | 'resize-end';

export interface BarDragState {
  rowId: string;
  mode: BarDragMode;
  pointerStartX: number;
  origStartMs: number;
  origEndMs: number;
}
