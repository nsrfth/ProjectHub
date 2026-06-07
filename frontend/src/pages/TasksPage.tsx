import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTeams } from '@/features/teams/TeamsContext';
import * as projectsApi from '@/features/projects/api';
import * as tasksApi from '@/features/tasks/api';
import { formatShamsiDate } from '@/lib/shamsi';
import { LabelChip } from '@/features/labels/LabelChip';
import { useT } from '@/lib/i18n';

const STATUS_ORDER: tasksApi.TaskStatus[] = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'];
const STATUS_LABEL: Record<tasksApi.TaskStatus, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  DONE: 'Done',
};
const PRIORITY_LABEL: Record<tasksApi.TaskPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Med',
  HIGH: 'High',
  URGENT: 'Urgent',
};
const PRIORITY_CLASS: Record<tasksApi.TaskPriority, string> = {
  LOW: 'text-slate-500',
  MEDIUM: 'text-slate-700',
  HIGH: 'text-amber-700',
  URGENT: 'text-red-700 font-semibold',
};

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

// Sortable card: one draggable item. Wraps the existing card markup; the drag
// handle is the whole card surface, with a small grab affordance in the corner.
// Click navigation still works because pointer-down vs. drag is disambiguated
// by @dnd-kit's PointerSensor activation distance.
interface SortableCardProps {
  task: tasksApi.Task;
  onOpen: (taskId: string) => void;
  onDelete: (task: tasksApi.Task) => void;
  onStatusChange: (task: tasksApi.Task, status: tasksApi.TaskStatus) => void;
}

function SortableCard({ task, onOpen, onDelete, onStatusChange }: SortableCardProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { columnId: task.status, kind: 'task' as const },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  // v1.12: paint the team's accent colour as a left stripe so cards from
  // different teams (in cross-team views) read instantly. Falls back to
  // slate when the team has no colour configured.
  const { currentTeam } = useTeams();
  const accent = currentTeam?.color ?? '#cbd5e1';
  return (
    <li
      ref={setNodeRef}
      style={{ ...style, borderLeft: `4px solid ${accent}` }}
      className="rounded border border-slate-200 p-2 text-sm bg-white"
      {...attributes}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          {...listeners}
          className="cursor-grab text-slate-400 text-xs select-none"
          aria-label="Drag handle"
          title="Drag to reorder"
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
        <button
          onClick={() => onDelete(task)}
          className="text-xs text-red-600 hover:underline shrink-0"
        >
          ✕
        </button>
      </div>
      {task.labels.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      {task.subtasks.length > 0 && (
        <div className="mt-1 text-[11px] text-slate-500">
          ☑ {task.subtasks.filter((s) => s.done).length}/{task.subtasks.length}
        </div>
      )}
      {/* v1.29: lock badge when the task has at least one incomplete
          FINISH_TO_START blocker. Tooltip says how many. */}
      {task.incompleteBlockerCount > 0 && (
        <div
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-700"
          title={`Blocked by ${task.incompleteBlockerCount} incomplete task${task.incompleteBlockerCount === 1 ? '' : 's'}`}
        >
          <span aria-hidden>🔒</span>
          <span>{task.incompleteBlockerCount}</span>
        </div>
      )}
      <div className="flex items-center justify-between mt-2 gap-2 text-xs">
        <span className={PRIORITY_CLASS[task.priority]}>{PRIORITY_LABEL[task.priority]}</span>
        <select
          value={task.status}
          onChange={(e) => onStatusChange(task, e.target.value as tasksApi.TaskStatus)}
          className="rounded border-slate-300 px-1 py-0.5 border text-xs"
          aria-label="Status (keyboard-accessible alternative to drag)"
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {(task.dueDate || task.plannedDate || task.completedAt) && (
        <div
          className="mt-1 flex flex-wrap justify-between gap-x-2 text-[11px] text-slate-500"
          dir="rtl"
        >
          {task.dueDate && <span>مهلت {formatShamsiDate(task.dueDate)}</span>}
          {task.plannedDate && (
            <span className="text-sky-700">هدف {formatShamsiDate(task.plannedDate)}</span>
          )}
          {task.completedAt && (
            <span className="text-emerald-700">انجام {formatShamsiDate(task.completedAt)}</span>
          )}
        </div>
      )}
    </li>
  );
}

// Column body: includes a useDroppable wrapper so a card dropped into an
// otherwise-empty column lands here (no card to be "before").
interface ColumnProps {
  status: tasksApi.TaskStatus;
  tasks: tasksApi.Task[];
  children: React.ReactNode;
}

function Column({ status, tasks, children }: ColumnProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${status}`,
    data: { columnId: status, kind: 'column' as const },
  });
  return (
    <div
      ref={setNodeRef}
      className={`bg-white rounded shadow p-3 ${isOver ? 'ring-2 ring-slate-300' : ''}`}
    >
      <h2 className="text-sm font-medium mb-2 flex items-center justify-between">
        <span>{STATUS_LABEL[status]}</span>
        <span className="text-xs text-slate-500">{tasks.length}</span>
      </h2>
      <ul className="space-y-2 min-h-[40px]">{children}</ul>
    </div>
  );
}

export default function TasksPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { currentTeam } = useTeams();
  const qc = useQueryClient();
  const nav = useNavigate();

  const teamId = currentTeam?.id ?? null;

  const { data: project } = useQuery({
    queryKey: ['projects', teamId, projectId],
    queryFn: async () => {
      if (!teamId || !projectId) return null;
      const all = await projectsApi.listProjects(teamId);
      return all.find((p) => p.id === projectId) ?? null;
    },
    enabled: !!teamId && !!projectId,
  });

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['tasks', teamId, projectId],
    queryFn: () => tasksApi.listTasks(teamId!, projectId!),
    enabled: !!teamId && !!projectId,
  });

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<tasksApi.TaskPriority>('MEDIUM');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (input: { title: string; priority: tasksApi.TaskPriority }) =>
      tasksApi.createTask(teamId!, projectId!, input),
    onSuccess: async () => {
      setTitle('');
      setPriority('MEDIUM');
      setCreateError(null);
      await qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] });
    },
    onError: (err) => setCreateError(errorMessage(err, 'Could not create task')),
  });

  const updateMut = useMutation({
    mutationFn: (input: { taskId: string; patch: Partial<tasksApi.Task> }) =>
      tasksApi.updateTask(
        teamId!,
        projectId!,
        input.taskId,
        input.patch as Parameters<typeof tasksApi.updateTask>[3],
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (taskId: string) => tasksApi.deleteTask(teamId!, projectId!, taskId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] });
    },
  });

  const reorderMut = useMutation({
    mutationFn: (input: {
      taskId: string;
      status: tasksApi.TaskStatus;
      beforeTaskId: string | null;
    }) =>
      tasksApi.reorderTask(teamId!, projectId!, input.taskId, {
        status: input.status,
        beforeTaskId: input.beforeTaskId,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] });
    },
  });

  // Activation distance prevents a click on a card (open detail) from being
  // misread as the start of a drag. 5px is the @dnd-kit default-ish that feels
  // right in casual testing.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Group tasks by status, preserving server-supplied position order.
  const grouped = useMemo(() => {
    const g: Record<tasksApi.TaskStatus, tasksApi.Task[]> = {
      TODO: [],
      IN_PROGRESS: [],
      REVIEW: [],
      DONE: [],
    };
    for (const t of tasks) g[t.status].push(t);
    return g;
  }, [tasks]);

  // v1.20: alternative view modes. Persisted in localStorage so the user's
  // preference survives page reloads.
  //   - status     — classic kanban (drag-and-drop).
  //   - technician — read-only per-Technician swimlanes (DnD would attempt a
  //     role-gated reassignment that MEMBERs can't perform).
  //   - list       — v1.33: dense sortable table. Same data; better for users
  //     who want to scan dozens of tasks without flipping between columns.
  type ViewMode = 'status' | 'technician' | 'list';
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'status';
    const stored = window.localStorage.getItem('kanban.viewMode');
    if (stored === 'technician' || stored === 'list') return stored;
    return 'status';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('kanban.viewMode', viewMode);
    }
  }, [viewMode]);

  // Group tasks by Technician — columns are deterministic by name (alphabetical),
  // with "Unassigned" pinned last when present.
  const groupedByTech = useMemo(() => {
    const buckets = new Map<string, { id: string | null; name: string; tasks: tasksApi.Task[] }>();
    for (const t of tasks) {
      const key = t.technicianId ?? '__unassigned__';
      const name = t.technicianName ?? '(unassigned)';
      let entry = buckets.get(key);
      if (!entry) {
        entry = { id: t.technicianId, name, tasks: [] };
        buckets.set(key, entry);
      }
      entry.tasks.push(t);
    }
    return [...buckets.values()].sort((a, b) => {
      if (a.id === null) return 1;
      if (b.id === null) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [tasks]);

  const t = useT();

  if (!currentTeam) {
    return (
      <div className="min-h-screen p-8 max-w-3xl mx-auto">
        <p className="text-sm text-slate-500">
          Select or{' '}
          <Link to="/teams" className="underline">
            create a team
          </Link>{' '}
          first.
        </p>
      </div>
    );
  }

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    createMut.mutate({ title, priority });
  }

  // Map a dnd-kit drop event to a backend reorder call. `over` can be either
  // another card (place before that card) or a column droppable (place at the
  // end). `active.id` is the dragged task's id.
  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    if (activeId === String(over.id)) return;

    const overData = over.data.current as
      | { columnId?: tasksApi.TaskStatus; kind?: 'task' | 'column' }
      | undefined;

    // Resolve target column + beforeTaskId.
    let targetStatus: tasksApi.TaskStatus | undefined;
    let beforeTaskId: string | null = null;
    if (overData?.kind === 'task' && overData.columnId) {
      targetStatus = overData.columnId;
      beforeTaskId = String(over.id);
    } else if (overData?.kind === 'column' && overData.columnId) {
      targetStatus = overData.columnId;
      beforeTaskId = null;
    }
    if (!targetStatus) return;

    reorderMut.mutate({ taskId: activeId, status: targetStatus, beforeTaskId });
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6 gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold truncate">{project?.name ?? 'Tasks'}</h1>
          <p className="text-sm text-slate-500">
            in <span className="font-medium">{currentTeam.name}</span>
          </p>
        </div>
        {/* Project context: a board belongs to one project — surface a quick
            jump back to the Projects list since that's the immediate parent
            in the URL hierarchy. The top nav handles dashboard / reports. */}
        <Link to="/projects" className="text-sm underline whitespace-nowrap">
          ← Projects
        </Link>
      </div>

      <section className="bg-white rounded shadow p-4 mb-6">
        <form onSubmit={onCreate} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            required
            placeholder="New task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="flex-1 min-w-[200px] rounded border-slate-300 px-2 py-1 border text-sm"
          />
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as tasksApi.TaskPriority)}
            className="rounded border-slate-300 px-2 py-1 border text-sm"
          >
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </select>
          <button
            type="submit"
            disabled={createMut.isPending}
            className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {createMut.isPending ? 'Adding…' : 'Add task'}
          </button>

          {/* v1.20: view-mode toggle. v1.33: added List. */}
          <div className="ms-auto inline-flex rounded border border-slate-300 dark:border-slate-600 overflow-hidden text-xs">
            {([
              { key: 'status', label: t('tasks.view.status') },
              { key: 'list', label: t('tasks.view.list') },
              { key: 'technician', label: t('tasks.view.technician') },
            ] as const).map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setViewMode(v.key)}
                className={`px-3 py-1 ${viewMode === v.key ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200'}`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </form>
        {createError && <p className="text-xs text-red-600 mt-2">{createError}</p>}
      </section>

      {isLoading && <p className="text-sm text-slate-500">Loading tasks…</p>}

      {viewMode === 'status' && (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {STATUS_ORDER.map((status) => (
              <Column key={status} status={status} tasks={grouped[status]}>
                <SortableContext
                  items={grouped[status].map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {grouped[status].map((t) => (
                    <SortableCard
                      key={t.id}
                      task={t}
                      onOpen={(id) => nav(`/projects/${projectId}/tasks/${id}`)}
                      onDelete={(task) => {
                        if (window.confirm(`Delete task "${task.title}"?`)) deleteMut.mutate(task.id);
                      }}
                      onStatusChange={(task, s) =>
                        updateMut.mutate({ taskId: task.id, patch: { status: s } })
                      }
                    />
                  ))}
                  {grouped[status].length === 0 && (
                    <li className="text-xs text-slate-400 italic py-2">
                      {reorderMut.isPending ? 'Saving…' : 'empty'}
                    </li>
                  )}
                </SortableContext>
              </Column>
            ))}
          </section>
        </DndContext>
      )}

      {viewMode === 'list' && (
        <TaskList
          tasks={tasks}
          t={t}
          onOpen={(id) => nav(`/projects/${projectId}/tasks/${id}`)}
          onStatusChange={(task, s) =>
            updateMut.mutate({ taskId: task.id, patch: { status: s } })
          }
          onDelete={(task) => {
            if (window.confirm(`Delete task "${task.title}"?`)) deleteMut.mutate(task.id);
          }}
        />
      )}

      {viewMode === 'technician' && (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {groupedByTech.length === 0 && (
            <p className="text-sm text-slate-500">No tasks yet.</p>
          )}
          {groupedByTech.map((g) => (
            <TechnicianColumn
              key={g.id ?? '__unassigned__'}
              name={g.name}
              tasks={g.tasks}
              onOpen={(id) => nav(`/projects/${projectId}/tasks/${id}`)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

// v1.33: dense sortable list view of the same tasks the kanban renders.
// Reuses the same data source (no extra fetch) and the same mutations
// (inline status select → updateTask; delete button → deleteTask). Sort
// state is local; default order is the server-supplied position (matches
// kanban). Clicking a column header cycles asc → desc → off, mirroring
// the conventional spreadsheet UX.
type SortKey =
  | 'title'
  | 'status'
  | 'priority'
  | 'technician'
  | 'dueDate'
  | 'plannedDate'
  | 'completedAt';
type SortDir = 'asc' | 'desc';
const PRIORITY_RANK: Record<tasksApi.TaskPriority, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  URGENT: 3,
};
const STATUS_RANK: Record<tasksApi.TaskStatus, number> = {
  TODO: 0,
  IN_PROGRESS: 1,
  REVIEW: 2,
  DONE: 3,
};
const STATUS_BADGE: Record<tasksApi.TaskStatus, string> = {
  TODO: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  IN_PROGRESS: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200',
  REVIEW: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200',
  DONE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200',
};

function TaskList({
  tasks,
  t,
  onOpen,
  onStatusChange,
  onDelete,
}: {
  tasks: tasksApi.Task[];
  t: (k: string) => string;
  onOpen: (taskId: string) => void;
  onStatusChange: (task: tasksApi.Task, status: tasksApi.TaskStatus) => void;
  onDelete: (task: tasksApi.Task) => void;
}): JSX.Element {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return tasks;
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Pull comparable values out per row; nulls always sort to the end.
    function valueOf(row: tasksApi.Task): string | number | null {
      switch (sort!.key) {
        case 'title':
          return row.title.toLocaleLowerCase();
        case 'status':
          return STATUS_RANK[row.status];
        case 'priority':
          return PRIORITY_RANK[row.priority];
        case 'technician':
          return row.technicianName?.toLocaleLowerCase() ?? null;
        case 'dueDate':
          return row.dueDate ?? null;
        case 'plannedDate':
          return row.plannedDate ?? null;
        case 'completedAt':
          return row.completedAt ?? null;
      }
    }
    return [...tasks].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [tasks, sort]);

  function onHeader(key: SortKey): void {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null; // third click clears
    });
  }

  if (tasks.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400 italic py-6 text-center">
        {t('tasks.list.empty')}
      </p>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded shadow overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-700/50 text-left text-xs text-slate-500 dark:text-slate-400 uppercase">
          <tr>
            <Th onClick={() => onHeader('title')} active={sort?.key === 'title'} dir={sort?.dir}>
              {t('tasks.col.title')}
            </Th>
            <Th onClick={() => onHeader('status')} active={sort?.key === 'status'} dir={sort?.dir}>
              {t('tasks.col.status')}
            </Th>
            <Th
              onClick={() => onHeader('priority')}
              active={sort?.key === 'priority'}
              dir={sort?.dir}
            >
              {t('tasks.col.priority')}
            </Th>
            <Th
              onClick={() => onHeader('technician')}
              active={sort?.key === 'technician'}
              dir={sort?.dir}
            >
              {t('tasks.col.technician')}
            </Th>
            <Th
              onClick={() => onHeader('dueDate')}
              active={sort?.key === 'dueDate'}
              dir={sort?.dir}
            >
              {t('tasks.col.due')}
            </Th>
            <Th
              onClick={() => onHeader('plannedDate')}
              active={sort?.key === 'plannedDate'}
              dir={sort?.dir}
              className="hidden xl:table-cell"
            >
              {t('tasks.col.planned')}
            </Th>
            <Th
              onClick={() => onHeader('completedAt')}
              active={sort?.key === 'completedAt'}
              dir={sort?.dir}
              className="hidden xl:table-cell"
            >
              {t('tasks.col.completed')}
            </Th>
            <th className="px-3 py-2 hidden md:table-cell">{t('tasks.col.labels')}</th>
            <th className="px-3 py-2 w-8"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.id}
              className="border-t border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40"
            >
              <td className="px-3 py-2 max-w-[20rem]">
                <button
                  type="button"
                  onClick={() => onOpen(row.id)}
                  className="text-left hover:underline truncate block w-full font-medium"
                >
                  {row.title}
                </button>
                {row.incompleteBlockerCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] text-amber-700 mt-0.5"
                    title={`Blocked by ${row.incompleteBlockerCount} incomplete task${row.incompleteBlockerCount === 1 ? '' : 's'}`}
                  >
                    <span aria-hidden>🔒</span>
                    {row.incompleteBlockerCount}
                  </span>
                )}
              </td>
              <td className="px-3 py-2">
                <select
                  value={row.status}
                  onChange={(e) =>
                    onStatusChange(row, e.target.value as tasksApi.TaskStatus)
                  }
                  className={`rounded px-2 py-0.5 text-xs border-0 ${STATUS_BADGE[row.status]}`}
                  aria-label="Status"
                >
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </td>
              <td className={`px-3 py-2 ${PRIORITY_CLASS[row.priority]}`}>
                {PRIORITY_LABEL[row.priority]}
              </td>
              <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                {row.technicianName ?? (
                  <span className="text-slate-400">{t('tasks.list.unassigned')}</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300" dir="rtl">
                {row.dueDate ? formatShamsiDate(row.dueDate) : ''}
              </td>
              <td
                className="px-3 py-2 text-xs text-sky-700 dark:text-sky-300 hidden xl:table-cell"
                dir="rtl"
              >
                {row.plannedDate ? formatShamsiDate(row.plannedDate) : ''}
              </td>
              <td
                className="px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 hidden xl:table-cell"
                dir="rtl"
              >
                {row.completedAt ? formatShamsiDate(row.completedAt) : ''}
              </td>
              <td className="px-3 py-2 hidden md:table-cell">
                {row.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {row.labels.map((l) => (
                      <LabelChip key={l.id} label={l} />
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-end">
                <button
                  type="button"
                  onClick={() => onDelete(row)}
                  className="text-xs text-red-600 hover:underline"
                  aria-label="Delete task"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  onClick,
  active,
  dir,
  className,
  children,
}: {
  onClick: () => void;
  active: boolean;
  dir: SortDir | undefined;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <th className={`px-3 py-2 font-medium select-none ${className ?? ''}`}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
      >
        {children}
        {active && (
          <span aria-hidden className="text-slate-400">
            {dir === 'asc' ? '▲' : '▼'}
          </span>
        )}
      </button>
    </th>
  );
}

// v1.20: read-only per-Technician swimlane. Mirrors the Column above visually
// but with no DnD machinery — reassigning a Technician is role-gated and
// happens from the task detail page.
function TechnicianColumn({
  name,
  tasks,
  onOpen,
}: {
  name: string;
  tasks: tasksApi.Task[];
  onOpen: (taskId: string) => void;
}): JSX.Element {
  return (
    <div className="bg-white rounded shadow p-3">
      <h2 className="text-sm font-medium mb-2 flex items-center justify-between">
        <span>{name}</span>
        <span className="text-xs text-slate-500">{tasks.length}</span>
      </h2>
      <ul className="space-y-2 min-h-[40px]">
        {tasks.map((t) => (
          <li
            key={t.id}
            onClick={() => onOpen(t.id)}
            className="bg-slate-50 dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 cursor-pointer rounded p-2 text-sm"
          >
            <p className="font-medium truncate">{t.title}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {t.status} · {t.priority}
            </p>
          </li>
        ))}
        {tasks.length === 0 && (
          <li className="text-xs text-slate-400 italic py-2">empty</li>
        )}
      </ul>
    </div>
  );
}
