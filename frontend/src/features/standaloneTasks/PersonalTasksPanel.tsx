import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useT } from '@/lib/i18n';
import { formatShamsiDate } from '@/lib/shamsi';
import * as projectsApi from '@/features/projects/api';
import type { TaskPriority } from '@/features/tasks/api';
import * as stApi from './api';
import type { StandaloneStatus, StandaloneTask } from './api';

const STATUSES: StandaloneStatus[] = ['TODO', 'IN_PROGRESS', 'DONE'];
const PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const PRIORITY_BADGE: Record<TaskPriority, string> = {
  LOW: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  MEDIUM: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  HIGH: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  URGENT: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

function isOverdue(t: StandaloneTask): boolean {
  if (!t.dueDate || t.status === 'DONE') return false;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return new Date(t.dueDate).getTime() < todayUtc;
}

export default function PersonalTasksPanel(): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [scope, setScope] = useState<'active' | 'deleted'>('active');

  // Create form.
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [dueDate, setDueDate] = useState('');

  // Promote dialog.
  const [promoteFor, setPromoteFor] = useState<StandaloneTask | null>(null);
  const [promoteProjectId, setPromoteProjectId] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['me', 'standalone-tasks'] });

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['me', 'standalone-tasks', scope],
    queryFn: () => stApi.listStandaloneTasks({ scope }),
  });

  const { data: projects = [] } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: projectsApi.listAllProjects,
  });

  const grouped = useMemo(() => {
    const m: Record<StandaloneStatus, StandaloneTask[]> = { TODO: [], IN_PROGRESS: [], DONE: [] };
    for (const it of items) m[it.status].push(it);
    return m;
  }, [items]);

  const createMut = useMutation({
    mutationFn: () =>
      stApi.createStandaloneTask({
        title: title.trim(),
        priority: priority || null,
        dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null,
      }),
    onSuccess: async () => {
      setTitle('');
      setPriority('');
      setDueDate('');
      await invalidate();
    },
  });

  const updateMut = useMutation({
    mutationFn: (a: { id: string; body: stApi.UpdateBody }) => stApi.updateStandaloneTask(a.id, a.body),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({ mutationFn: stApi.deleteStandaloneTask, onSuccess: invalidate });
  const restoreMut = useMutation({ mutationFn: stApi.restoreStandaloneTask, onSuccess: invalidate });
  const reorderMut = useMutation({
    mutationFn: (a: { status: StandaloneStatus; ids: string[] }) =>
      stApi.reorderStandaloneTasks(a.status, a.ids),
    onSuccess: invalidate,
  });
  const promoteMut = useMutation({
    mutationFn: (a: { id: string; projectId: string }) => stApi.promoteStandaloneTask(a.id, a.projectId),
    onSuccess: async () => {
      setPromoteFor(null);
      setPromoteProjectId('');
      await invalidate();
    },
  });

  function onCreate(e: FormEvent): void {
    e.preventDefault();
    if (!title.trim()) return;
    createMut.mutate();
  }

  function move(list: StandaloneTask[], status: StandaloneStatus, index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const ids = list.map((x) => x.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorderMut.mutate({ status, ids });
  }

  return (
    <div>
      <p className="text-sm text-slate-500 mb-3">{t('standaloneTasks.hint')}</p>

      {scope === 'active' && (
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-2 mb-4 text-sm">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('standaloneTasks.titlePlaceholder')}
            className="rounded border px-2 py-1 dark:bg-slate-800 min-w-[16rem] flex-1"
          />
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority | '')}
            className="rounded border px-2 py-1 dark:bg-slate-800"
            aria-label={t('standaloneTasks.priority')}
          >
            <option value="">{t('standaloneTasks.noPriority')}</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`forms.field.priority.${p.toLowerCase()}`)}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="rounded border px-2 py-1 dark:bg-slate-800"
            aria-label={t('standaloneTasks.dueDate')}
          />
          <button
            type="submit"
            disabled={createMut.isPending || !title.trim()}
            className="rounded bg-slate-900 text-white px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {t('standaloneTasks.add')}
          </button>
        </form>
      )}

      <div className="flex gap-2 mb-4 text-sm">
        {(['active', 'deleted'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={`px-3 py-1 rounded ${
              scope === s ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'border border-slate-300'
            }`}
          >
            {t(`standaloneTasks.scope.${s}`)}
          </button>
        ))}
      </div>

      {createMut.isError && (
        <p className="text-xs text-danger mb-2">{errorMessage(createMut.error, 'Failed')}</p>
      )}
      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}

      {!isLoading && items.length === 0 && (
        <p className="text-sm text-slate-500">{t('standaloneTasks.empty')}</p>
      )}

      {scope === 'active' ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {STATUSES.map((status) => (
            <section key={status} className="bg-surface rounded shadow p-3">
              <h3 className="text-xs font-semibold uppercase text-text-muted mb-2">
                {t(`standaloneTasks.status.${status}`)} ({grouped[status].length})
              </h3>
              <ul className="space-y-2">
                {grouped[status].map((task, i) => (
                  <li key={task.id} className="rounded border border-border p-2 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className={task.status === 'DONE' ? 'line-through text-text-muted' : ''}>
                        {task.title}
                      </span>
                      <div className="flex flex-col items-end gap-0.5">
                        <button
                          type="button"
                          onClick={() => move(grouped[status], status, i, -1)}
                          disabled={i === 0}
                          className="text-xs text-text-muted disabled:opacity-30"
                          aria-label="Move up"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => move(grouped[status], status, i, 1)}
                          disabled={i === grouped[status].length - 1}
                          className="text-xs text-text-muted disabled:opacity-30"
                          aria-label="Move down"
                        >
                          ▼
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      {task.priority && (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${PRIORITY_BADGE[task.priority]}`}>
                          {t(`forms.field.priority.${task.priority.toLowerCase()}`)}
                        </span>
                      )}
                      {task.dueDate && (
                        <span className={`text-[11px] ${isOverdue(task) ? 'text-danger font-medium' : 'text-text-muted'}`}>
                          {formatShamsiDate(task.dueDate)}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1 mt-2">
                      <select
                        value={task.status}
                        onChange={(e) =>
                          updateMut.mutate({ id: task.id, body: { status: e.target.value as StandaloneStatus } })
                        }
                        className="rounded border px-1 py-0.5 text-xs dark:bg-slate-800"
                        aria-label={t('standaloneTasks.changeStatus')}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(`standaloneTasks.status.${s}`)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          setPromoteFor(task);
                          setPromoteProjectId('');
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        {t('standaloneTasks.promote')}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteMut.mutate(task.id)}
                        className="text-xs text-danger hover:underline"
                      >
                        {t('standaloneTasks.delete')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="space-y-2 max-w-2xl">
          {items.map((task) => (
            <li key={task.id} className="rounded border border-border p-2 text-sm flex items-center justify-between">
              <span className="text-text-muted line-through">{task.title}</span>
              <button
                type="button"
                onClick={() => restoreMut.mutate(task.id)}
                className="text-xs text-primary hover:underline"
              >
                {t('standaloneTasks.restore')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {promoteFor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-surface rounded shadow-lg p-4 w-full max-w-md">
            <h3 className="font-medium mb-1">{t('standaloneTasks.promoteTitle')}</h3>
            <p className="text-xs text-text-muted mb-3">{t('standaloneTasks.promoteHint')}</p>
            <p className="text-sm mb-2">“{promoteFor.title}”</p>
            <select
              value={promoteProjectId}
              onChange={(e) => setPromoteProjectId(e.target.value)}
              className="w-full rounded border px-2 py-1 text-sm dark:bg-slate-800 mb-3"
            >
              <option value="">{t('standaloneTasks.chooseProject')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {promoteMut.isError && (
              <p className="text-xs text-danger mb-2">{errorMessage(promoteMut.error, 'Failed')}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPromoteFor(null)}
                className="text-sm px-3 py-1.5 rounded border border-slate-300"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!promoteProjectId || promoteMut.isPending}
                onClick={() => promoteMut.mutate({ id: promoteFor.id, projectId: promoteProjectId })}
                className="text-sm px-3 py-1.5 rounded bg-slate-900 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
              >
                {t('standaloneTasks.promote')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
