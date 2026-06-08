import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as subtasksApi from './api';
import { ShamsiDatePicker } from '@/lib/ShamsiDatePicker';
import { formatShamsiCalendarDate } from '@/lib/shamsi';

// v1.35: subtask list with full-permutation drag-and-drop reorder.
// `subtasks` comes from the parent task query (server-supplied position
// asc). Local order is mirrored from props until the user drags; on
// drop, we apply the move locally + fire one reorderSubtasks PATCH with
// the full permutation. The server rejects partial / duplicate / foreign
// id lists with 400; on error we invalidate via onChange() to roll the
// list back to the server's view.

export interface SubtaskItem {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  // v1.41: optional scheduling window. ISO strings; null when unset.
  startDate?: string | null;
  endDate?: string | null;
  // v1.42: assignee — distinct from technician. Null when unassigned.
  assigneeId?: string | null;
  assigneeName?: string | null;
  position: number;
}

interface SubtaskListProps {
  teamId: string;
  projectId: string;
  taskId: string;
  subtasks: SubtaskItem[];
  // v1.42: team members for the per-row assignee dropdown. Parent fetches
  // once and passes them down; we render `{name}` options + an "unassigned"
  // sentinel. Server validates membership on submit.
  teamMembers?: Array<{ userId: string; name: string }>;
  // Caller decides what to refresh on every mutation (typically the task
  // detail query + the kanban list so the progress chip stays in sync).
  onChange: () => Promise<void> | void;
}

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export function SubtaskList({
  teamId,
  projectId,
  taskId,
  subtasks,
  teamMembers = [],
  onChange,
}: SubtaskListProps): JSX.Element {
  const [title, setTitle] = useState('');

  // Local order — mirrors `subtasks` until a drag fires. The effect below
  // keeps it in lockstep with server updates between drags so a parent
  // refetch reflects without stomping a mid-drag local order.
  const [localOrder, setLocalOrder] = useState<SubtaskItem[]>(subtasks);
  useEffect(() => {
    setLocalOrder(subtasks);
  }, [subtasks]);

  const createMut = useMutation({
    mutationFn: () => subtasksApi.createSubtask(teamId, projectId, taskId, { title }),
    onSuccess: async () => {
      setTitle('');
      await onChange();
    },
  });

  const updateMut = useMutation({
    mutationFn: (input: { id: string; done: boolean }) =>
      subtasksApi.updateSubtask(teamId, projectId, taskId, input.id, { done: input.done }),
    onSuccess: async () => {
      await onChange();
    },
  });

  // v1.42: per-row assignee PATCH. Anyone with project access can change
  // (no permission gate); server validates the user is a team member.
  const updateAssigneeMut = useMutation({
    mutationFn: (input: { id: string; assigneeId: string | null }) =>
      subtasksApi.updateSubtask(teamId, projectId, taskId, input.id, {
        assigneeId: input.assigneeId,
      }),
    onSuccess: async () => {
      await onChange();
    },
    onError: async (err) => {
      window.alert(errorMessage(err, 'Could not save assignee'));
      await onChange();
    },
  });

  // v1.41: per-row dates PATCH (independent mutation so toggling done
  // doesn't fight a date save). Sends both fields together so the
  // backend sees a merged, valid range in one shot.
  const updateDatesMut = useMutation({
    mutationFn: (input: {
      id: string;
      startDate: string | null;
      endDate: string | null;
    }) =>
      subtasksApi.updateSubtask(teamId, projectId, taskId, input.id, {
        startDate: input.startDate,
        endDate: input.endDate,
      }),
    onSuccess: async () => {
      await onChange();
    },
    onError: async (err) => {
      window.alert(errorMessage(err, 'Could not save dates'));
      await onChange();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => subtasksApi.deleteSubtask(teamId, projectId, taskId, id),
    onSuccess: async () => {
      await onChange();
    },
  });

  const reorderMut = useMutation({
    mutationFn: (ids: string[]) =>
      subtasksApi.reorderSubtasks(teamId, projectId, taskId, ids),
    onSuccess: async () => {
      await onChange();
    },
    onError: async (err) => {
      window.alert(errorMessage(err, 'Could not reorder subtasks'));
      // Roll local order back to whatever the server now says.
      await onChange();
    },
  });

  function onAdd(e: FormEvent): void {
    e.preventDefault();
    if (!title.trim()) return;
    createMut.mutate();
  }

  // Activation distance prevents a checkbox click from being misread as
  // the start of a drag. Same value the kanban uses.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = localOrder.map((s) => s.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const nextIds = arrayMove(ids, from, to);
    const byId = new Map(localOrder.map((s) => [s.id, s]));
    const nextOrder = nextIds.map((id) => byId.get(id)!).filter(Boolean);
    setLocalOrder(nextOrder);
    reorderMut.mutate(nextIds);
  }

  const done = localOrder.filter((s) => s.done).length;
  const total = localOrder.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-slate-600 dark:text-slate-400">Subtasks</h3>
        {total > 0 && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {done} / {total} done
          </span>
        )}
      </div>

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext items={localOrder.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {localOrder.map((s) => (
              <SortableRow
                key={s.id}
                subtask={s}
                onToggle={(done) => updateMut.mutate({ id: s.id, done })}
                onDelete={() => deleteMut.mutate(s.id)}
                onSaveDates={(startDate, endDate) =>
                  updateDatesMut.mutate({ id: s.id, startDate, endDate })
                }
                datesPending={updateDatesMut.isPending}
                // v1.42: assignee dropdown wiring.
                teamMembers={teamMembers}
                onAssign={(assigneeId) => updateAssigneeMut.mutate({ id: s.id, assigneeId })}
                assigneePending={updateAssigneeMut.isPending}
              />
            ))}
            {total === 0 && <li className="text-xs text-slate-400 italic">No subtasks.</li>}
          </ul>
        </SortableContext>
      </DndContext>

      <form onSubmit={onAdd} className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Add a subtask…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 border text-sm"
        />
        <button
          type="submit"
          disabled={createMut.isPending || !title.trim()}
          className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  );
}

function SortableRow({
  subtask,
  onToggle,
  onDelete,
  onSaveDates,
  datesPending,
  teamMembers,
  onAssign,
  assigneePending,
}: {
  subtask: SubtaskItem;
  onToggle: (done: boolean) => void;
  onDelete: () => void;
  // v1.41: per-row date editor. Parent owns the mutation; the row just
  // collects the two ISO strings (or null) and submits.
  onSaveDates: (startDate: string | null, endDate: string | null) => void;
  datesPending: boolean;
  // v1.42: per-row assignee dropdown wiring.
  teamMembers: Array<{ userId: string; name: string }>;
  onAssign: (assigneeId: string | null) => void;
  assigneePending: boolean;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: subtask.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  // v1.41: inline date editor. Collapsed by default — opened via the 📅
  // affordance to keep the list visually clean when no dates are set.
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState<string | null>(subtask.startDate ?? null);
  const [end, setEnd] = useState<string | null>(subtask.endDate ?? null);
  useEffect(() => {
    setStart(subtask.startDate ?? null);
    setEnd(subtask.endDate ?? null);
  }, [subtask.startDate, subtask.endDate]);

  const hasDates = !!(subtask.startDate || subtask.endDate);
  const formattedRange = hasDates
    ? `${formatShamsiCalendarDate(subtask.startDate) ?? '…'} → ${
        formatShamsiCalendarDate(subtask.endDate) ?? '…'
      }`
    : null;
  // Client-side mirror of the server rule so the Save button reflects
  // validity. The server still re-validates on submit.
  const rangeInvalid =
    !!start && !!end && new Date(end).getTime() < new Date(start).getTime();

  return (
    <li ref={setNodeRef} style={style} className="text-sm" {...attributes}>
      <div className="flex items-center gap-2">
        <span
          {...listeners}
          className="cursor-grab text-slate-400 text-xs select-none"
          aria-label="Drag handle"
          title="Drag to reorder"
        >
          ⋮⋮
        </span>
        <input
          type="checkbox"
          checked={subtask.done}
          onChange={(e) => onToggle(e.target.checked)}
          className="cursor-pointer"
          aria-label={`Mark "${subtask.title}" ${subtask.done ? 'incomplete' : 'done'}`}
        />
        <span
          className={
            subtask.done
              ? 'line-through text-slate-400 dark:text-slate-500 flex-1'
              : 'flex-1 text-slate-800 dark:text-slate-100'
          }
        >
          {subtask.title}
        </span>
        {formattedRange && !editing && (
          <span
            className="text-xs text-slate-500 dark:text-slate-400 truncate"
            title="Scheduled window"
          >
            {formattedRange}
          </span>
        )}
        {/* v1.42: per-row assignee dropdown. Hidden when no team members
            were passed in (defensive: avoids an empty dropdown). Shows
            "unassigned" by default; server validates membership on submit. */}
        {teamMembers.length > 0 && (
          <select
            value={subtask.assigneeId ?? ''}
            onChange={(e) => onAssign(e.target.value || null)}
            disabled={assigneePending}
            className="text-xs rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-1 py-0.5 max-w-[10rem]"
            title={subtask.assigneeName ? `Assigned to ${subtask.assigneeName}` : 'Assign'}
            aria-label={`Assignee for subtask ${subtask.title}`}
          >
            <option value="">— unassigned —</option>
            {teamMembers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className={
            'text-xs px-1 rounded ' +
            (editing
              ? 'bg-slate-200 dark:bg-slate-700'
              : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200')
          }
          aria-label={
            editing
              ? `Close date editor for subtask ${subtask.title}`
              : `Edit dates for subtask ${subtask.title}`
          }
          title={hasDates ? 'Edit dates' : 'Add dates'}
        >
          📅
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-red-600 hover:underline opacity-60 hover:opacity-100"
          aria-label={`Delete subtask ${subtask.title}`}
        >
          ×
        </button>
      </div>
      {editing && (
        <div className="ml-7 mt-1 mb-2 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <span className="text-slate-500 dark:text-slate-400">Start</span>
            <ShamsiDatePicker value={start} onChange={setStart} />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-slate-500 dark:text-slate-400">End</span>
            <ShamsiDatePicker value={end} onChange={setEnd} />
          </label>
          {rangeInvalid && (
            <span className="text-red-600 dark:text-red-400">
              End must be on or after Start.
            </span>
          )}
          <div className="flex gap-1 ml-auto">
            <button
              type="button"
              disabled={datesPending || rangeInvalid}
              onClick={() => {
                onSaveDates(start, end);
                setEditing(false);
              }}
              className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-2 py-0.5 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              disabled={datesPending}
              onClick={() => {
                // Clear convenience: submit null/null without leaving the editor.
                setStart(null);
                setEnd(null);
                onSaveDates(null, null);
                setEditing(false);
              }}
              className="text-slate-500 dark:text-slate-400 hover:underline"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                setStart(subtask.startDate ?? null);
                setEnd(subtask.endDate ?? null);
                setEditing(false);
              }}
              className="text-slate-500 dark:text-slate-400 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
