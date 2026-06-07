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
const PRIORITY_CLASS: Record<tasksApi.TaskPriority, string> = {
  LOW: 'text-slate-500',
  MEDIUM: 'text-slate-700 dark:text-slate-300',
  HIGH: 'text-amber-700 dark:text-amber-400',
  URGENT: 'text-red-700 dark:text-red-400 font-semibold',
};

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
}

export default function BucketBoard({ teamId, projectId, onOpenTask }: Props): JSX.Element {
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
  const tasks = tasksQ.data ?? [];

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

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {/* Unbucketed column — always first. Not draggable / not deletable. */}
        <UnbucketedColumn
          tasks={byBucket.get(UNBUCKETED) ?? []}
          onOpenTask={onOpenTask}
          t={t}
        />

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
  onOpenTask,
  t,
}: {
  tasks: tasksApi.Task[];
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
      <ColumnTaskList tasks={tasks} columnId={bucket.id} onOpenTask={onOpenTask} />
    </div>
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
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="rounded border border-slate-200 dark:border-slate-700 p-2 text-sm bg-white dark:bg-slate-800"
      {...attributes}
    >
      <div className="flex items-start gap-2">
        <span
          {...listeners}
          className="cursor-grab text-slate-400 text-xs select-none"
          aria-label="Drag handle"
        >
          ⋮⋮
        </span>
        <button
          type="button"
          onClick={() => onOpen(task.id)}
          className="font-medium break-words text-left hover:underline flex-1 min-w-0"
        >
          {task.title}
        </button>
      </div>
      {task.labels.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between mt-2 gap-2 text-xs">
        <span className={PRIORITY_CLASS[task.priority]}>{PRIORITY_LABEL[task.priority]}</span>
        <span className="text-[10px] uppercase tracking-wide text-slate-400">{task.status}</span>
      </div>
      {task.dueDate && (
        <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400" dir="rtl">
          مهلت {formatShamsiDate(task.dueDate)}
        </div>
      )}
      {task.incompleteBlockerCount > 0 && (
        <div
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
          title={`Blocked by ${task.incompleteBlockerCount} incomplete task${task.incompleteBlockerCount === 1 ? '' : 's'}`}
        >
          <span aria-hidden>🔒</span>
          <span>{task.incompleteBlockerCount}</span>
        </div>
      )}
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
