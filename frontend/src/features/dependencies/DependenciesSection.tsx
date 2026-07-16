import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Link } from 'react-router-dom';
import {
  addDependency,
  listDependencies,
  removeDependency,
  type DependencyEdge,
  type DependencyType,
} from './api';
import { listTasks, type Task } from '@/features/tasks/api';
import { useT } from '@/lib/i18n';

// v1.29: Dependencies section for TaskDetailPage. Renders "Blocked by" +
// "Blocking" lists plus an add-picker. The server is authoritative on cycle
// detection + permission gating; we surface the 409 / 403 as inline errors.

interface Props {
  teamId: string;
  projectId: string;
  taskId: string;
}

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data?.error;
    if (data?.code === 'DEPENDENCY_CYCLE') return 'Adding this would create a cycle.';
    if (data?.code === 'CONFLICT') return 'That dependency already exists.';
    const msg = data?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

const STATUS_LABEL: Record<string, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  REVIEW: 'Review',
  DONE: 'Done',
};

// v1.83: dependency type picker order + i18n keys.
const DEP_TYPE_ORDER: DependencyType[] = [
  'FINISH_TO_START',
  'START_TO_START',
  'FINISH_TO_FINISH',
  'RELATES_TO',
];
const DEP_TYPE_I18N: Record<DependencyType, string> = {
  FINISH_TO_START: 'dependency.type.fs',
  START_TO_START: 'dependency.type.ss',
  FINISH_TO_FINISH: 'dependency.type.ff',
  RELATES_TO: 'dependency.type.relates',
};

export default function DependenciesSection({ teamId, projectId, taskId }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['dependencies', taskId],
    queryFn: () => listDependencies(teamId, projectId, taskId),
  });

  // The picker pulls every task in the same project — the dependent has to be
  // in the same project per the server rule. Cached for 30s.
  const { data: tasks } = useQuery({
    queryKey: ['tasks', teamId, projectId],
    queryFn: () => listTasks(teamId, projectId),
    staleTime: 30_000,
  });

  const [picker, setPicker] = useState<string>('');
  const [pickerType, setPickerType] = useState<DependencyType>('FINISH_TO_START');
  const [error, setError] = useState<string | null>(null);

  const addMut = useMutation({
    mutationFn: (dependsOnId: string) =>
      addDependency(teamId, projectId, taskId, { dependsOnId, type: pickerType }),
    onSuccess: async () => {
      setPicker('');
      setError(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['dependencies', taskId] }),
        // The dependent task's incompleteBlockerCount changed too.
        qc.invalidateQueries({ queryKey: ['task', taskId] }),
        qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] }),
      ]);
    },
    onError: (err) => setError(errorMessage(err, t('deps.addError'))),
  });

  const removeMut = useMutation({
    mutationFn: (dependencyId: string) =>
      removeDependency(teamId, projectId, taskId, dependencyId),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['dependencies', taskId] }),
        qc.invalidateQueries({ queryKey: ['task', taskId] }),
        qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] }),
      ]),
  });

  // Picker options: every task in the project EXCEPT
  //   - the current task (would be a self-loop)
  //   - any task already listed as a blocker (duplicate edge)
  const blockedByIds = useMemo(
    () => new Set((data?.blockedBy ?? []).map((d) => d.task.id)),
    [data?.blockedBy],
  );
  const pickerOptions = useMemo(
    () =>
      (tasks ?? [])
        .filter((task: Task) => task.id !== taskId && !blockedByIds.has(task.id))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [tasks, taskId, blockedByIds],
  );

  const enforcement = data?.enforcement ?? 'off';

  return (
    <div className="mt-5 pt-4 border-t">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-xs font-medium text-text">
          {t('deps.title')}
        </h3>
        {enforcement !== 'off' && (
          <span
            className={
              enforcement === 'block'
                ? 'text-[10px] uppercase tracking-wide text-danger'
                : 'text-[10px] uppercase tracking-wide text-warning'
            }
            title={t(`deps.enforcement.${enforcement}.help`)}
          >
            {t(`deps.enforcement.${enforcement}.label`)}
          </span>
        )}
      </div>

      {isLoading && <p className="text-xs text-slate-400">{t('deps.loading')}</p>}

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <EdgeColumn
            title={t('deps.blockedBy')}
            empty={t('deps.blockedByEmpty')}
            edges={data.blockedBy}
            onRemove={(id) => removeMut.mutate(id)}
            t={t}
          />
          <EdgeColumn
            title={t('deps.blocking')}
            empty={t('deps.blockingEmpty')}
            edges={data.blocking}
            onRemove={(id) => removeMut.mutate(id)}
            t={t}
          />
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (picker) addMut.mutate(picker);
        }}
        className="mt-3 flex flex-wrap items-center gap-2"
      >
        <label className="text-xs text-text">{t('deps.add')}</label>
        <select
          value={picker}
          onChange={(e) => setPicker(e.target.value)}
          className="rounded border-border px-2 py-1 border text-sm bg-surface max-w-xs"
        >
          <option value="">{t('deps.pickPlaceholder')}</option>
          {pickerOptions.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title} · {STATUS_LABEL[task.status] ?? task.status}
            </option>
          ))}
        </select>
        <select
          value={pickerType}
          onChange={(e) => setPickerType(e.target.value as DependencyType)}
          aria-label={t('dependency.type.label')}
          title={t('dependency.type.label')}
          className="rounded border-border px-2 py-1 border text-sm bg-surface"
        >
          {DEP_TYPE_ORDER.map((tp) => (
            <option key={tp} value={tp}>
              {t(DEP_TYPE_I18N[tp])}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!picker || addMut.isPending}
          className="text-xs rounded bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-3 py-1 disabled:opacity-50"
        >
          {addMut.isPending ? '…' : t('deps.addButton')}
        </button>
      </form>
      {error && <p role="alert" className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}

function EdgeColumn({
  title,
  empty,
  edges,
  onRemove,
  t,
}: {
  title: string;
  empty: string;
  edges: DependencyEdge[];
  onRemove: (id: string) => void;
  t: (k: string) => string;
}): JSX.Element {
  if (edges.length === 0) {
    return (
      <div>
        <h4 className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
          {title}
        </h4>
        <p className="text-xs text-slate-400 italic">{empty}</p>
      </div>
    );
  }
  return (
    <div>
      <h4 className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1">
        {title}
      </h4>
      <ul className="space-y-1">
        {edges.map((edge) => (
          <li
            key={edge.id}
            className="flex items-center justify-between gap-2 text-sm rounded border border-border px-2 py-1"
          >
            <Link
              to={`/projects/${edge.task.projectId}/tasks/${edge.task.id}`}
              className="truncate underline decoration-slate-300 hover:decoration-slate-700"
            >
              <span
                className={
                  edge.task.status === 'DONE'
                    ? 'text-slate-400 line-through'
                    : 'text-text'
                }
              >
                {edge.task.title}
              </span>
            </Link>
            <span className="flex items-center gap-2 shrink-0">
              <span
                className="text-[10px] rounded bg-bg-elevated px-1.5 py-0.5 text-text"
                title={t('dependency.type.label')}
              >
                {t(DEP_TYPE_I18N[edge.type])}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                {STATUS_LABEL[edge.task.status] ?? edge.task.status}
              </span>
              <button
                type="button"
                onClick={() => onRemove(edge.id)}
                aria-label="Remove dependency"
                className="text-[11px] text-danger hover:underline"
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
