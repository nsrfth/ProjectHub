import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useTeams } from '@/features/teams/TeamsContext';
import * as projectsApi from '@/features/projects/api';
import * as tasksApi from '@/features/tasks/api';
import { formatShamsiDate } from '@/lib/shamsi';
import { LabelChip } from '@/features/labels/LabelChip';

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
  const { currentTeam } = useTeams();
  const qc = useQueryClient();
  const nav = useNavigate();

  const teamId = currentTeam?.id ?? null;

  const { data: project } = useQuery({
    queryKey: ['projects', teamId, projectId],
    // The list endpoint is the cheapest way to materialize the project's name
    // without a dedicated GET-by-id call from this page; we re-use the data.
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
      tasksApi.updateTask(teamId!, projectId!, input.taskId, input.patch as Parameters<typeof tasksApi.updateTask>[3]),
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

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    createMut.mutate({ title, priority });
  }

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

  // Group tasks by status for the simple column view.
  const grouped: Record<tasksApi.TaskStatus, tasksApi.Task[]> = {
    TODO: [],
    IN_PROGRESS: [],
    REVIEW: [],
    DONE: [],
  };
  for (const t of tasks) grouped[t.status].push(t);

  return (
    <div className="min-h-screen p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">{project?.name ?? 'Tasks'}</h1>
          <p className="text-sm text-slate-500">
            in <span className="font-medium">{currentTeam.name}</span>
          </p>
        </div>
        <Link to="/projects" className="text-sm underline">
          ← Projects
        </Link>
      </header>

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
        </form>
        {createError && <p className="text-xs text-red-600 mt-2">{createError}</p>}
      </section>

      {isLoading && <p className="text-sm text-slate-500">Loading tasks…</p>}

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {STATUS_ORDER.map((status) => (
          <div key={status} className="bg-white rounded shadow p-3">
            <h2 className="text-sm font-medium mb-2 flex items-center justify-between">
              <span>{STATUS_LABEL[status]}</span>
              <span className="text-xs text-slate-500">{grouped[status].length}</span>
            </h2>
            <ul className="space-y-2">
              {grouped[status].map((t) => (
                <li key={t.id} className="rounded border border-slate-200 p-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => nav(`/projects/${projectId}/tasks/${t.id}`)}
                      className="font-medium break-words text-left hover:underline flex-1 min-w-0"
                    >
                      {t.title}
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete task "${t.title}"?`)) deleteMut.mutate(t.id);
                      }}
                      className="text-xs text-red-600 hover:underline shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                  {t.labels.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.labels.map((l) => (
                        <LabelChip key={l.id} label={l} />
                      ))}
                    </div>
                  )}
                  {t.subtasks.length > 0 && (
                    <div className="mt-1 text-[11px] text-slate-500">
                      ☑ {t.subtasks.filter((s) => s.done).length}/{t.subtasks.length}
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-2 gap-2 text-xs">
                    <span className={PRIORITY_CLASS[t.priority]}>{PRIORITY_LABEL[t.priority]}</span>
                    <select
                      value={t.status}
                      onChange={(e) =>
                        updateMut.mutate({
                          taskId: t.id,
                          patch: { status: e.target.value as tasksApi.TaskStatus },
                        })
                      }
                      className="rounded border-slate-300 px-1 py-0.5 border text-xs"
                    >
                      {STATUS_ORDER.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {(t.dueDate || t.doneAt) && (
                    <div className="mt-1 flex justify-between text-[11px] text-slate-500" dir="rtl">
                      {t.dueDate && <span>سررسید {formatShamsiDate(t.dueDate)}</span>}
                      {t.doneAt && (
                        <span className="text-emerald-700">انجام {formatShamsiDate(t.doneAt)}</span>
                      )}
                    </div>
                  )}
                </li>
              ))}
              {grouped[status].length === 0 && (
                <li className="text-xs text-slate-400 italic">empty</li>
              )}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
