import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as tasksApi from '@/features/tasks/api';
import * as subtasksApi from '@/features/subtasks/api';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import {
  daysBetween,
  initials,
  statusBarColor,
  utcDayIso,
  utcDayMs,
} from './utils';
import { countWorkingDaysInclusive } from '@/lib/workingDays';
import { isSchedulingWorkingDaysOnly } from '@/lib/scheduling';
import type { BarDragMode, BarDragState, TimelineRow } from './types';

interface Props {
  row: TimelineRow;
  axisStartMs: number;
  dayPx: number;
  rowTop: number;
  todayMs: number;
  onDragStart: (state: BarDragState) => void;
  dragState: BarDragState | null;
  dragDeltaDays: number;
}

export default function TimelineBar({
  row,
  axisStartMs,
  dayPx,
  rowTop,
  todayMs,
  onDragStart,
  dragState,
  dragDeltaDays,
}: Props): JSX.Element | null {
  if (!row.barStart || !row.barEnd || row.kind === 'project') return null;

  let startMs = utcDayMs(row.barStart);
  let endMs = utcDayMs(row.barEnd);

  const isDragging = dragState?.rowId === row.id;
  if (isDragging) {
    const mode = dragState.mode;
    if (mode === 'move') {
      const delta = dragDeltaDays * 86_400_000;
      startMs += delta;
      endMs += delta;
    } else if (mode === 'resize-start') {
      startMs += dragDeltaDays * 86_400_000;
    } else if (mode === 'resize-end') {
      endMs += dragDeltaDays * 86_400_000;
    }
    if (endMs < startMs) {
      if (mode === 'resize-start') startMs = endMs;
      else endMs = startMs;
    }
  }

  const x = daysBetween(axisStartMs, startMs) * dayPx;
  const widthDays = daysBetween(startMs, endMs) + 1;
  const w = Math.max(4, widthDays * dayPx - 4);
  const y = rowTop + 6;
  const h = 24;
  const fill = statusBarColor(row.status, row.done);
  const overdue = !row.done && endMs < todayMs;
  const progressW = Math.round((w * row.progress) / 100);

  const startIso = utcDayIso(startMs);
  const endIso = utcDayIso(endMs);
  const calDays = widthDays;
  const workingDays = isSchedulingWorkingDaysOnly()
    ? countWorkingDaysInclusive(startIso, endIso)
    : null;

  const tooltip = [
    row.label,
    `Start: ${formatShamsiCalendarDate(startIso) ?? ''}`,
    `End: ${formatShamsiCalendarDate(endIso) ?? ''}`,
    workingDays !== null
      ? `Duration: ${workingDays} working day(s) (${calDays} calendar day(s))`
      : null,
    row.assigneeName ? `Assignee: ${row.assigneeName}` : '',
    `Status: ${row.status}${row.done ? ' / done' : ''}`,
    row.progress > 0 ? `Progress: ${row.progress}%` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const startDrag = (mode: BarDragMode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onDragStart({
      rowId: row.id,
      mode,
      pointerStartX: e.clientX,
      origStartMs: utcDayMs(row.barStart!),
      origEndMs: utcDayMs(row.barEnd!),
    });
  };

  const showLabel = w > 48;

  return (
    <div
      className="absolute group"
      style={{ left: x + 2, top: y, width: w, height: h }}
      title={tooltip}
    >
      <div
        className={`relative h-full rounded-md shadow-sm cursor-grab active:cursor-grabbing ${
          overdue ? 'ring-2 ring-red-500' : ''
        } ${isDragging ? 'opacity-90 z-20' : 'z-10'}`}
        style={{ background: fill }}
        onPointerDown={startDrag('move')}
      >
        {row.progress > 0 && row.progress < 100 && (
          <div
            className="absolute inset-y-0 left-0 rounded-l-md bg-black/15 pointer-events-none"
            style={{ width: progressW }}
          />
        )}
        {showLabel && (
          <span className="absolute inset-0 flex items-center px-2 text-[11px] font-medium text-white truncate pointer-events-none">
            {row.label}
          </span>
        )}
        {row.assigneeName && w > 28 && (
          <span
            className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white/90 text-[9px] font-bold text-slate-700 flex items-center justify-center pointer-events-none"
            title={row.assigneeName}
          >
            {initials(row.assigneeName)}
          </span>
        )}
      </div>
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/40 rounded-l-md"
        onPointerDown={startDrag('resize-start')}
        aria-label="Resize start"
      />
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/40 rounded-r-md"
        onPointerDown={startDrag('resize-end')}
        aria-label="Resize end"
      />
    </div>
  );
}

export function useTimelineBarDrag(
  rows: TimelineRow[],
  dayPx: number,
): {
  dragState: BarDragState | null;
  dragDeltaDays: number;
  onDragStart: (state: BarDragState) => void;
} {
  const qc = useQueryClient();
  const [dragState, setDragState] = useState<BarDragState | null>(null);
  const [dragDeltaDays, setDragDeltaDays] = useState(0);
  const dragRef = useRef<BarDragState | null>(null);

  const updateTaskMut = useMutation({
    mutationFn: async (args: {
      teamId: string;
      projectId: string;
      taskId: string;
      startDate: string;
      dueDate: string;
    }) =>
      tasksApi.updateTask(args.teamId, args.projectId, args.taskId, {
        startDate: args.startDate,
        dueDate: args.dueDate,
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['tasks', vars.teamId, vars.projectId] });
    },
  });

  const updateSubtaskMut = useMutation({
    mutationFn: async (args: {
      teamId: string;
      projectId: string;
      taskId: string;
      subtaskId: string;
      startDate: string;
      endDate: string;
    }) =>
      subtasksApi.updateSubtask(args.teamId, args.projectId, args.taskId, args.subtaskId, {
        startDate: args.startDate,
        endDate: args.endDate,
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['tasks', vars.teamId, vars.projectId] });
    },
  });

  const commitDrag = useCallback(
    (state: BarDragState, deltaDays: number) => {
      const row = rows.find((r) => r.id === state.rowId);
      if (!row || !row.barStart || !row.barEnd) return;

      let startMs = state.origStartMs;
      let endMs = state.origEndMs;

      if (state.mode === 'move') {
        const delta = deltaDays * 86_400_000;
        startMs += delta;
        endMs += delta;
      } else if (state.mode === 'resize-start') {
        startMs += deltaDays * 86_400_000;
      } else if (state.mode === 'resize-end') {
        endMs += deltaDays * 86_400_000;
      }
      if (endMs < startMs) {
        if (state.mode === 'resize-start') startMs = endMs;
        else endMs = startMs;
      }

      const startIso = utcDayIso(startMs);
      const endIso = utcDayIso(endMs);

      if (row.kind === 'subtask' && row.subtaskId && row.taskId) {
        updateSubtaskMut.mutate({
          teamId: row.teamId,
          projectId: row.projectId,
          taskId: row.taskId,
          subtaskId: row.subtaskId,
          startDate: startIso,
          endDate: endIso,
        });
      } else if (row.kind === 'task' && row.taskId) {
        updateTaskMut.mutate({
          teamId: row.teamId,
          projectId: row.projectId,
          taskId: row.taskId,
          startDate: startIso,
          dueDate: endIso,
        });
      }
    },
    [rows, updateSubtaskMut, updateTaskMut],
  );

  const onDragStart = useCallback(
    (state: BarDragState) => {
      dragRef.current = state;
      setDragState(state);
      setDragDeltaDays(0);

      const onMove = (e: PointerEvent) => {
        const cur = dragRef.current;
        if (!cur) return;
        const dx = e.clientX - cur.pointerStartX;
        setDragDeltaDays(Math.round(dx / dayPx));
      };

      const onUp = (e: PointerEvent) => {
        const cur = dragRef.current;
        if (cur) {
          const dx = e.clientX - cur.pointerStartX;
          const delta = Math.round(dx / dayPx);
          if (delta !== 0) commitDrag(cur, delta);
        }
        dragRef.current = null;
        setDragState(null);
        setDragDeltaDays(0);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [dayPx, commitDrag],
  );

  return {
    dragState,
    dragDeltaDays,
    onDragStart,
  };
}
