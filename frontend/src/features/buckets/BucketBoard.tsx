import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as bucketsApi from '@/features/buckets/api';
import * as tasksApi from '@/features/tasks/api';
import { useT } from '@/lib/i18n';
import { LabelChip } from '@/features/labels/LabelChip';
import { formatShamsiDate } from '@/lib/shamsi';

// v1.34.1: Buckets view of a project. Renders one column per bucket
// (ordered by Bucket.order asc) + a leading "(unbucketed)" column for
// tasks with bucketId === null.
//
// DnD model:
//   - Card drop into a bucket column → PATCH /tasks/:taskId { bucketId }.
//   - Bucket-column header drag → full-permutation reorder via PATCH
//     /buckets/reorder. Optimistic — rolls back on 400.
//   - Within-column card reorder is intentionally NOT wired in this
//     release. The Kanban view (status mode) is the authoritative
//     position-reorder surface; Buckets focuses on cross-bucket moves.

const PRIORITY_LABEL: Record<tasksApi.TaskPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Med',
  HIGH: 'High',
  URGENT: 'Urgent',
};
// v1.34.3: PRIORITY_CLASS replaced by PRIORITY_DOT (defined alongside
// BucketTaskCard) — the polished card uses a small colored dot instead
// of the text-coloured label string.

const UNBUCKETED = '__unbucketed__';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

interface Props {
  teamId: string;
  projectId: string;
  onOpenTask: (taskId: string) => void;
  // v1.36: optional label filter forwarded from TasksPage's ?labels=
  // query-param state. Null/empty = no filter. OR semantics: a task is
  // shown if it carries at least one of the supplied labelIds.
  filterLabelIds?: string[] | null;
}

export default function BucketBoard({
  teamId,
  projectId,
  onOpenTask,
  filterLabelIds,
}: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();

  const bucketsQ = useQuery({
    queryKey: ['buckets', teamId, projectId],
    queryFn: () => bucketsApi.listBuckets(teamId, projectId),
  });
  const tasksQ = useQuery({
    queryKey: ['tasks', teamId, projectId],
    queryFn: () => tasksApi.listTasks(teamId, projectId),
  });

  const buckets = bucketsQ.data ?? [];
  const allTasks = tasksQ.data ?? [];

  // v1.36: apply the label filter before grouping. OR semantics — task
  // shown if it carries at least one of the selected labels. Null /
  // empty filter passes through.
  const tasks = useMemo(() => {
    if (!filterLabelIds || filterLabelIds.length === 0) return allTasks;
    const wanted = new Set(filterLabelIds);
    return allTasks.filter((tk) => tk.labels.some((l) => wanted.has(l.id)));
  }, [allTasks, filterLabelIds]);

  // Group tasks by bucketId. (unbucketed) is keyed by UNBUCKETED.
  const byBucket = useMemo(() => {
    const m = new Map<string, tasksApi.Task[]>();
    m.set(UNBUCKETED, []);
    for (const b of buckets) m.set(b.id, []);
    for (const tk of tasks) {
      const key = tk.bucketId ?? UNBUCKETED;
      const arr = m.get(key);
      if (arr) arr.push(tk);
      else m.set(key, [tk]);
    }
    // Stable order within a column: server-supplied position asc.
    for (const arr of m.values()) {
      arr.sort((a, b) => a.position - b.position);
    }
    return m;
  }, [tasks, buckets]);

  // ── Mutations ───────────────────────────────────────────────────────────

  const moveTaskMut = useMutation({
    mutationFn: (input: { taskId: string; bucketId: string | null }) =>
      tasksApi.updateTask(teamId, projectId, input.taskId, { bucketId: input.bucketId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] }),
    onError: (err) => window.alert(errorMessage(err, 'Could not move task')),
  });

  const reorderBucketsMut = useMutation({
    mutationFn: (bucketIds: string[]) => bucketsApi.reorderBuckets(teamId, projectId, bucketIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['buckets', teamId, projectId] }),
    onError: (err) => {
      // Rollback the optimistic reorder by re-fetching from the server.
      qc.invalidateQueries({ queryKey: ['buckets', teamId, projectId] });
      window.alert(errorMessage(err, 'Could not reorder buckets'));
    },
  });

  // Optimistic local order for the bucket columns. We mirror the
  // server-supplied order until the user drags; on drag-end we apply the
  // new order locally + fire the API call. Rollback happens via
  // queryClient invalidation on error.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const orderedBuckets = useMemo(() => {
    if (!localOrder) return buckets;
    const byId = new Map(buckets.map((b) => [b.id, b]));
    const out: bucketsApi.Bucket[] = [];
    for (const id of localOrder) {
      const b = byId.get(id);
      if (b) out.push(b);
    }
    return out;
  }, [buckets, localOrder]);
  // Reset local override whenever the server data changes (mutation success).
  if (
    localOrder &&
    buckets.length === localOrder.length &&
    buckets.every((b, i) => b.id === orderedBuckets[i]?.id)
  ) {
    // Server caught up; drop the override on the next render.
    queueMicrotask(() => setLocalOrder(null));
  }

  // ── DnD wiring ──────────────────────────────────────────────────────────

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const activeKind = (active.data.current as { kind?: string } | undefined)?.kind;
    const overKind = (over.data.current as { kind?: string } | undefined)?.kind;

    // Column reorder.
    if (activeKind === 'column' && overKind === 'column') {
      if (activeId === overId) return;
      const ids = orderedBuckets.map((b) => b.id);
      const from = ids.indexOf(activeId);
      const to = ids.indexOf(overId);
      if (from < 0 || to < 0) return;
      const next = arrayMove(ids, from, to);
      setLocalOrder(next);
      reorderBucketsMut.mutate(next);
      return;
    }

    // Task move (cross-column).
    if (activeKind === 'task') {
      // Target column id can be either a column droppable (header drop) or
      // another task inside a column (card drop). Resolve to bucketId | null.
      let targetBucketId: string | null = null;
      if (overKind === 'column-drop') {
        const colId = (over.data.current as { columnId?: string } | undefined)?.columnId;
        if (colId === undefined) return;
        targetBucketId = colId === UNBUCKETED ? null : colId;
      } else if (overKind === 'task') {
        const colId = (over.data.current as { columnId?: string } | undefined)?.columnId;
        if (colId === undefined) return;
        targetBucketId = colId === UNBUCKETED ? null : colId;
      } else {
        return;
      }
      const task = tasks.find((tk) => tk.id === activeId);
      if (!task) return;
      const currentBucket = task.bucketId ?? null;
      if (currentBucket === targetBucketId) return;
      moveTaskMut.mutate({ taskId: activeId, bucketId: targetBucketId });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  if (bucketsQ.isLoading || tasksQ.isLoading) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  }

  // v1.34.3: hide the (unbucketed) column when it has no tasks — Planner
  // doesn't have one because every task lives in a bucket. We still keep
  // it around for tasks created pre-v1.34.0 (bucketId = NULL) so they
  // remain visible, but otherwise the UI stays clean.
  const unbucketedTasks = byBucket.get(UNBUCKETED) ?? [];

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {unbucketedTasks.length > 0 && (
          <UnbucketedColumn
            tasks={unbucketedTasks}
            teamId={teamId}
            projectId={projectId}
            onOpenTask={onOpenTask}
            t={t}
          />
        )}

        {/* Bucket columns — draggable. */}
        <SortableContext
          items={orderedBuckets.map((b) => b.id)}
          strategy={horizontalListSortingStrategy}
        >
          {orderedBuckets.map((b) => (
            <BucketColumn
              key={b.id}
              bucket={b}
              tasks={byBucket.get(b.id) ?? []}
              teamId={teamId}
              projectId={projectId}
              onOpenTask={onOpenTask}
              t={t}
            />
          ))}
        </SortableContext>

        {/* Add-bucket affordance — appended at the end of the row. */}
        <AddBucketColumn teamId={teamId} projectId={projectId} t={t} />
      </div>
    </DndContext>
  );
}

// ── Column components ────────────────────────────────────────────────────

function UnbucketedColumn({
  tasks,
  teamId,
  projectId,
  onOpenTask,
  t,
}: {
  tasks: tasksApi.Task[];
  teamId: string;
  projectId: string;
  onOpenTask: (id: string) => void;
  t: (k: string) => string;
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: UNBUCKETED,
    data: { kind: 'column-drop', columnId: UNBUCKETED },
  });
  return (
    <div
      ref={setNodeRef}
      className={[
        'shrink-0 w-72 bg-slate-50 dark:bg-slate-800/60 border border-dashed border-slate-300 dark:border-slate-700 rounded p-2',
        isOver ? 'ring-2 ring-indigo-300' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between mb-2 text-sm">
        <span className="font-medium text-slate-500 dark:text-slate-400 italic">
          {t('buckets.unbucketed')}
        </span>
        <span className="text-xs text-slate-400">{tasks.length}</span>
      </div>
      <AddTaskInline teamId={teamId} projectId={projectId} bucketId={null} t={t} />
      <ColumnTaskList tasks={tasks} columnId={UNBUCKETED} onOpenTask={onOpenTask} />
    </div>
  );
}

function BucketColumn({
  bucket,
  tasks,
  teamId,
  projectId,
  onOpenTask,
  t,
}: {
  bucket: bucketsApi.Bucket;
  tasks: tasksApi.Task[];
  teamId: string;
  projectId: string;
  onOpenTask: (id: string) => void;
  t: (k: string) => string;
}): JSX.Element {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  // Header sortable wiring — only the header is the drag handle for column
  // reorder. Task cards live in a separate SortableContext below.
  const { attributes, listeners, setNodeRef: setHeaderRef, transform, transition, isDragging } =
    useSortable({ id: bucket.id, data: { kind: 'column' } });
  const headerStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Drop target for cross-column task moves.
  const { setNodeRef: setColumnRef, isOver } = useDroppable({
    id: `col-${bucket.id}`,
    data: { kind: 'column-drop', columnId: bucket.id },
  });

  const renameMut = useMutation({
    mutationFn: (name: string) => bucketsApi.renameBucket(teamId, bucket.id, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['buckets', teamId, projectId] }),
    onError: (err) => window.alert(errorMessage(err, 'Could not rename bucket')),
  });

  const deleteMut = useMutation({
    mutationFn: () => bucketsApi.deleteBucket(teamId, bucket.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['buckets', teamId, projectId] });
      qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not delete bucket')),
  });

  return (
    <div
      ref={(node) => {
        setHeaderRef(node);
        setColumnRef(node);
      }}
      style={headerStyle}
      className={[
        'shrink-0 w-72 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded p-2',
        isOver ? 'ring-2 ring-indigo-400' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          {...attributes}
          {...listeners}
          className="cursor-grab text-slate-400 text-xs select-none"
          title={t('buckets.dragHandle')}
          aria-label={t('buckets.dragHandle')}
        >
          ⋮⋮
        </span>
        {editing ? (
          <RenameInline
            initial={bucket.name}
            onSave={(name) => {
              if (name && name !== bucket.name) renameMut.mutate(name);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 text-left text-sm font-medium text-slate-800 dark:text-slate-100 truncate hover:underline"
            title={t('buckets.rename')}
          >
            {bucket.name}
          </button>
        )}
        <span className="text-xs text-slate-400 shrink-0">{tasks.length}</span>
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm(
                t('buckets.deleteConfirm').replace('{name}', bucket.name),
              )
            ) {
              deleteMut.mutate();
            }
          }}
          className="text-xs text-red-600 hover:underline disabled:opacity-50 shrink-0"
          disabled={deleteMut.isPending}
          aria-label={t('buckets.delete')}
          title={t('buckets.delete')}
        >
          ×
        </button>
      </div>
      <AddTaskInline teamId={teamId} projectId={projectId} bucketId={bucket.id} t={t} />
      <ColumnTaskList tasks={tasks} columnId={bucket.id} onOpenTask={onOpenTask} />
    </div>
  );
}

// v1.34.3: Planner-style "+ Add task" affordance inside each column.
// Collapsed to a one-line button; expands to a title input + Enter to
// submit. Creates the task pre-bucketed via the createTask endpoint that
// gained `bucketId` support in v1.34.3 — no second PATCH round-trip.
function AddTaskInline({
  teamId,
  projectId,
  bucketId,
  t,
}: {
  teamId: string;
  projectId: string;
  bucketId: string | null;
  t: (k: string) => string;
}): JSX.Element {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');

  const createMut = useMutation({
    mutationFn: (input: { title: string }) =>
      tasksApi.createTask(teamId, projectId, { title: input.title, bucketId }),
    onSuccess: () => {
      setTitle('');
      qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not create task')),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    createMut.mutate({ title: trimmed });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded px-1.5 py-1 mb-2 hover:bg-slate-100 dark:hover:bg-slate-700/40"
      >
        + {t('buckets.addTask')}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mb-2">
      <input
        autoFocus
        type="text"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (!title.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setTitle('');
          }
        }}
        placeholder={t('buckets.taskPlaceholder')}
        className="w-full rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-xs"
      />
    </form>
  );
}

function AddBucketColumn({
  teamId,
  projectId,
  t,
}: {
  teamId: string;
  projectId: string;
  t: (k: string) => string;
}): JSX.Element {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const createMut = useMutation({
    mutationFn: () => bucketsApi.createBucket(teamId, projectId, { name: name.trim() }),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['buckets', teamId, projectId] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not create bucket')),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!name.trim()) return;
    createMut.mutate();
  }

  return (
    <form
      onSubmit={submit}
      className="shrink-0 w-72 border border-dashed border-slate-300 dark:border-slate-700 rounded p-2 self-start"
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('buckets.newPlaceholder')}
        maxLength={80}
        className="w-full rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm mb-2"
      />
      <button
        type="submit"
        disabled={createMut.isPending || !name.trim()}
        className="w-full text-sm rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1 font-medium disabled:opacity-50"
      >
        {createMut.isPending ? t('buckets.adding') : `+ ${t('buckets.add')}`}
      </button>
    </form>
  );
}

// ── Sortable task list inside one column ────────────────────────────────

function ColumnTaskList({
  tasks,
  columnId,
  onOpenTask,
}: {
  tasks: tasksApi.Task[];
  columnId: string;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  return (
    <SortableContext
      items={tasks.map((tk) => tk.id)}
      strategy={verticalListSortingStrategy}
    >
      <ul className="space-y-2 min-h-[40px]">
        {tasks.map((tk) => (
          <BucketTaskCard key={tk.id} task={tk} columnId={columnId} onOpen={onOpenTask} />
        ))}
        {tasks.length === 0 && (
          <li className="text-xs text-slate-400 italic py-2 text-center">empty</li>
        )}
      </ul>
    </SortableContext>
  );
}

// v1.34.3: Planner-style task card. Visual signals at a glance:
//   - priority colored dot (top-left, beside the drag handle)
//   - inline checklist count: ☑ done/total — using existing Subtask data
//   - due-date pill at the bottom (red if overdue)
//   - technician initials avatar bottom-right
//   - blocker lock badge (unchanged from v1.34.1)
const PRIORITY_DOT: Record<tasksApi.TaskPriority, string> = {
  LOW: 'bg-slate-300 dark:bg-slate-600',
  MEDIUM: 'bg-slate-400 dark:bg-slate-500',
  HIGH: 'bg-amber-500',
  URGENT: 'bg-red-600',
};

function initialsOf(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

function BucketTaskCard({
  task,
  columnId,
  onOpen,
}: {
  task: tasksApi.Task;
  columnId: string;
  onOpen: (id: string) => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { kind: 'task', columnId },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const subtaskTotal = task.subtasks.length;
  const subtaskDone = task.subtasks.filter((s) => s.done).length;
  const overdue =
    task.dueDate &&
    new Date(task.dueDate).getTime() < Date.now() &&
    task.status !== 'DONE';

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm hover:shadow text-sm overflow-hidden"
      {...attributes}
    >
      <div className="p-2.5 space-y-2">
        <div className="flex items-start gap-2">
          <span
            className={`mt-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOT[task.priority]}`}
            title={`Priority: ${PRIORITY_LABEL[task.priority]}`}
            aria-label={`Priority ${PRIORITY_LABEL[task.priority]}`}
          />
          <span
            {...listeners}
            className="cursor-grab text-slate-400 text-xs select-none mt-0.5"
            aria-label="Drag handle"
          >
            ⋮⋮
          </span>
          <button
            type="button"
            onClick={() => onOpen(task.id)}
            className="text-left hover:underline flex-1 min-w-0 break-words text-slate-800 dark:text-slate-100 font-medium"
          >
            {task.title}
          </button>
        </div>

        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.labels.map((l) => (
              <LabelChip key={l.id} label={l} />
            ))}
          </div>
        )}

        {/* Bottom meta row: start + due pills on the left, badges + avatar on the right. */}
        <div className="flex items-center gap-2 text-[11px] flex-wrap">
          {task.startDate && (
            <span
              className="inline-flex items-center gap-1 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 px-1.5 py-0.5"
              title="Started on"
            >
              <span aria-hidden>🚀</span>
              <span dir="rtl">{formatShamsiDate(task.startDate)}</span>
            </span>
          )}
          {task.dueDate && (
            <span
              className={[
                'inline-flex items-center gap-1 rounded border px-1.5 py-0.5',
                overdue
                  ? 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400'
                  : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300',
              ].join(' ')}
              title={overdue ? 'Overdue' : 'Due date'}
            >
              <span aria-hidden>📅</span>
              <span dir="rtl">{formatShamsiDate(task.dueDate)}</span>
            </span>
          )}

          {subtaskTotal > 0 && (
            <span
              className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400"
              title={`${subtaskDone} of ${subtaskTotal} subtasks done`}
            >
              <span aria-hidden>☑</span>
              <span className="tabular-nums">
                {subtaskDone}/{subtaskTotal}
              </span>
            </span>
          )}

          {task.incompleteBlockerCount > 0 && (
            <span
              className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
              title={`Blocked by ${task.incompleteBlockerCount} incomplete task${task.incompleteBlockerCount === 1 ? '' : 's'}`}
            >
              <span aria-hidden>🔒</span>
              <span>{task.incompleteBlockerCount}</span>
            </span>
          )}

          {task.technicianName && (
            <span
              className="ms-auto inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-500 text-white text-[10px] font-semibold"
              title={task.technicianName}
              aria-label={`Technician: ${task.technicianName}`}
            >
              {initialsOf(task.technicianName)}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

// ── Inline rename ────────────────────────────────────────────────────────

function RenameInline({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSave(value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }
  return (
    <input
      autoFocus
      type="text"
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onSave(value.trim())}
      onKeyDown={onKey}
      className="flex-1 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-0.5 text-sm"
    />
  );
}
