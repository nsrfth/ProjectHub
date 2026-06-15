import { useEffect, useMemo, useState, Fragment, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useProjectTeam } from '@/features/projects/useProjectTeam';
import * as tasksApi from '@/features/tasks/api';
import { toggleExpandedTaskIds } from '@/features/tasks/taskListCollapse';
import * as labelsApi from '@/features/labels/api';
import { formatShamsiDate, formatShamsiTimestampDate } from '@/lib/shamsi';
import { LabelChip } from '@/features/labels/LabelChip';
import { useT } from '@/lib/i18n';
import PlannerNav from '@/features/planner/PlannerNav';
import GroupedBoard from '@/features/planner/GroupedBoard';
import {
  BOARD_GROUP_BY_LABEL,
  BOARD_GROUP_BY_ORDER,
  groupTasks,
  type BoardGroupBy,
} from '@/features/planner/grouping';
import { loadBoardGroupBy, saveBoardGroupBy } from '@/features/planner/storage';
import { listTeamMembersForAssignees } from '@/features/teams/api';
import { visibleTeamMembers } from '@/lib/systemUser';
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

export default function TasksPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { teamId, project, projectTeam } = useProjectTeam(projectId);
  const qc = useQueryClient();
  const nav = useNavigate();

  // v1.36: hoisted above the label-filter useMemo so the filter logic
  // can read ?labels=. v1.34.2's `?view=` reader (further down) still
  // works against this same getter.
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['tasks', teamId, projectId],
    queryFn: () => tasksApi.listTasks(teamId!, projectId!),
    enabled: !!teamId && !!projectId,
  });

  // v1.36: team labels for the filter strip. Cached briefly so re-renders
  // don't hammer the API.
  const { data: teamMembers = [] } = useQuery({
    queryKey: ['teams', teamId, 'assignees'],
    queryFn: () => listTeamMembersForAssignees(teamId!),
    enabled: !!teamId,
  });

  const assigneeNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of visibleTeamMembers(teamMembers)) {
      m.set(mem.userId, mem.name || mem.email);
    }
    return m;
  }, [teamMembers]);

  const [boardGroupBy, setBoardGroupBy] = useState<BoardGroupBy>(() => loadBoardGroupBy());

  const { data: teamLabels = [] } = useQuery({
    queryKey: ['labels', teamId],
    queryFn: () => labelsApi.listLabels(teamId!),
    enabled: !!teamId,
    staleTime: 60_000,
  });

  // v1.36: parse `?labels=id1,id2` into a Set; if no label has its id
  // in the team's available labels (stale URL after a label delete),
  // they're filtered out silently.
  const selectedLabelIds = useMemo(() => {
    const raw = searchParams.get('labels');
    if (!raw) return new Set<string>();
    const valid = new Set(teamLabels.map((l) => l.id));
    const out = new Set<string>();
    for (const id of raw.split(',')) {
      const trimmed = id.trim();
      if (trimmed && valid.has(trimmed)) out.add(trimmed);
    }
    return out;
  }, [searchParams, teamLabels]);

  function toggleLabel(labelId: string): void {
    const next = new Set(selectedLabelIds);
    if (next.has(labelId)) next.delete(labelId);
    else next.add(labelId);
    const newParams = new URLSearchParams(searchParams);
    if (next.size === 0) newParams.delete('labels');
    else newParams.set('labels', [...next].join(','));
    setSearchParams(newParams, { replace: true });
  }
  function clearLabels(): void {
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('labels');
    setSearchParams(newParams, { replace: true });
  }

  // v1.36: apply the label filter once at the top so every view-mode
  // path gets the same set. OR semantics: a task matches if it carries
  // AT LEAST ONE of the selected labels. No selection → show everything.
  const filteredTasks = useMemo(() => {
    if (selectedLabelIds.size === 0) return tasks;
    return tasks.filter((tk) => tk.labels.some((l) => selectedLabelIds.has(l.id)));
  }, [tasks, selectedLabelIds]);

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

  // v1.20: alternative view modes. Persisted in localStorage so the user's
  // preference survives page reloads.
  //   - status     — classic kanban (drag-and-drop).
  //   - technician — read-only per-Technician swimlanes (DnD would attempt a
  //     role-gated reassignment that MEMBERs can't perform).
  //   - list       — v1.33: dense sortable table. Same data; better for users
  //     who want to scan dozens of tasks without flipping between columns.
  type ViewMode = 'status' | 'technician' | 'list';
  // Honour `?view=` on the URL on first render; subsequent toggles persist
  // in localStorage.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const fromUrl = searchParams.get('view');
    if (fromUrl === 'status' || fromUrl === 'technician' || fromUrl === 'list') {
      return fromUrl;
    }
    if (typeof window === 'undefined') return 'status';
    const stored = window.localStorage.getItem('kanban.viewMode');
    if (stored === 'status' || stored === 'technician' || stored === 'list') {
      return stored;
    }
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
    for (const t of filteredTasks) {
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
  }, [filteredTasks]);

  const boardColumns = useMemo(
    () => groupTasks(filteredTasks, boardGroupBy, teamLabels, assigneeNames),
    [filteredTasks, boardGroupBy, teamLabels, assigneeNames],
  );

  const t = useT();

  if (!teamId || !project) {
    return (
      <div className="min-h-screen p-8 max-w-3xl mx-auto">
        <p className="text-sm text-slate-500">
          {projectId ? (
            <>
              Project not found or you don&apos;t have access.{' '}
              <Link to="/projects" className="underline">
                Back to projects
              </Link>
            </>
          ) : (
            <>
              Select or{' '}
              <Link to="/teams" className="underline">
                create a team
              </Link>{' '}
              first.
            </>
          )}
        </p>
      </div>
    );
  }

  const teamAccent = projectTeam?.color ?? '#cbd5e1';

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    createMut.mutate({ title, priority });
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <PlannerNav />
      <div className="flex items-center justify-between mb-6 gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold truncate">{project?.name ?? 'Tasks'}</h1>
          <p className="text-sm text-slate-500">
            in <span className="font-medium">{project.teamName}</span>
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
          {viewMode === 'status' && (
            <select
              value={boardGroupBy}
              onChange={(e) => {
                const v = e.target.value as BoardGroupBy;
                setBoardGroupBy(v);
                saveBoardGroupBy(v);
              }}
              className="rounded border-slate-300 px-2 py-1 border text-sm dark:bg-slate-800"
              aria-label="Group by"
            >
              {BOARD_GROUP_BY_ORDER.map((g) => (
                <option key={g} value={g}>
                  {t('planner.groupBy')}: {BOARD_GROUP_BY_LABEL[g]}
                </option>
              ))}
            </select>
          )}
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

      {/* v1.36: label filter strip. Renders only when the team has at least
          one label. Click a chip to toggle inclusion in `?labels=`; OR
          semantics across selections. */}
      {teamLabels.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
          <span className="text-slate-500 dark:text-slate-400">
            {t('labels.filterBy')}
          </span>
          {teamLabels.map((l) => {
            const active = selectedLabelIds.has(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => toggleLabel(l.id)}
                className={[
                  'transition-opacity',
                  active ? 'opacity-100' : 'opacity-40 hover:opacity-80',
                ].join(' ')}
                aria-pressed={active}
              >
                <LabelChip label={l} size="md" />
              </button>
            );
          })}
          {selectedLabelIds.size > 0 && (
            <button
              type="button"
              onClick={clearLabels}
              className="ms-2 underline text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              {t('labels.clearFilter')}
            </button>
          )}
        </div>
      )}

      {viewMode === 'status' && (
        <GroupedBoard
          columns={boardColumns}
          accent={teamAccent}
          enableDnD={boardGroupBy === 'status'}
          onOpen={(id) => nav(`/projects/${projectId}/tasks/${id}`)}
          onDelete={(task) => {
            if (window.confirm(`Delete task "${task.title}"?`)) deleteMut.mutate(task.id);
          }}
          onStatusChange={(task, s) =>
            updateMut.mutate({ taskId: task.id, patch: { status: s } })
          }
          onReorder={(taskId, status, beforeTaskId) =>
            reorderMut.mutate({ taskId, status, beforeTaskId })
          }
        />
      )}

      {viewMode === 'list' && (
        <TaskList
          tasks={filteredTasks}
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
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());

  const sorted = useMemo(() => {
    if (!sort) return tasks;
    const dir = sort.dir === 'asc' ? 1 : -1;
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
      return null;
    });
  }

  function toggleSubtasks(taskId: string): void {
    setExpandedTaskIds((prev) => toggleExpandedTaskIds(prev, taskId));
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
          {sorted.map((row) => {
            const hasSubtasks = row.subtasks.length > 0;
            const expanded = expandedTaskIds.has(row.id);
            return (
              <Fragment key={row.id}>
                <tr className="border-t border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40">
                  <td className="px-3 py-2 max-w-[20rem]">
                    <div className="flex items-start gap-1.5 min-w-0">
                      {hasSubtasks ? (
                        <button
                          type="button"
                          onClick={() => toggleSubtasks(row.id)}
                          className="inline-flex items-center gap-1 shrink-0 mt-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-600 px-0.5"
                          aria-expanded={expanded}
                          aria-label={t('tasks.subtasks.toggle')}
                          title={t('tasks.subtasks.count').replace(
                            '{count}',
                            String(row.subtasks.length),
                          )}
                        >
                          <SubtaskChevron expanded={expanded} />
                          <span className="text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                            {row.subtasks.length}
                          </span>
                        </button>
                      ) : (
                        <span className="w-5 shrink-0" aria-hidden />
                      )}
                      <div className="min-w-0">
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
                      </div>
                    </div>
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
                    {row.completedAt ? formatShamsiTimestampDate(row.completedAt) : ''}
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
                {expanded &&
                  row.subtasks.map((sub) => (
                    <tr
                      key={sub.id}
                      className="border-t border-slate-50 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/60"
                    >
                      <td className="px-3 py-1.5 max-w-[20rem] ps-8">
                        <button
                          type="button"
                          onClick={() => onOpen(row.id)}
                          className={`text-left hover:underline truncate block w-full text-xs ${
                            sub.done ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          {sub.title}
                        </button>
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-[10px] ${
                            sub.done
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200'
                              : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {sub.done ? t('tasks.subtasks.done') : t('tasks.subtasks.open')}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-slate-400 text-xs">—</td>
                      <td className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300">
                        {sub.assigneeName ?? sub.technicianName ?? (
                          <span className="text-slate-400">{t('tasks.list.unassigned')}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300" dir="rtl">
                        {sub.endDate ? formatShamsiDate(sub.endDate) : ''}
                      </td>
                      <td
                        className="px-3 py-1.5 text-xs text-sky-700 dark:text-sky-300 hidden xl:table-cell"
                        dir="rtl"
                      >
                        {sub.startDate ? formatShamsiDate(sub.startDate) : ''}
                      </td>
                      <td className="px-3 py-1.5 hidden xl:table-cell" />
                      <td className="px-3 py-1.5 hidden md:table-cell" />
                      <td className="px-3 py-1.5" />
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SubtaskChevron({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={[
        'inline-block text-slate-500 transition-transform duration-150',
        expanded ? 'rotate-90' : 'rtl:rotate-180',
      ].join(' ')}
    >
      ▸
    </span>
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
