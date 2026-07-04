import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import * as corrApi from './api';
import { useT } from '@/lib/i18n';

interface LinkedTasksPanelProps {
  teamId: string;
  projectId: string;
  letterId: string;
  canManage: boolean;
}

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

// v2.5.26 (W2.2): the letter ↔ task bridge. Lists tasks created from this letter
// and offers "create a task from this letter" — the task lands in the letter's
// project via the existing task service.
export function LinkedTasksPanel({
  teamId,
  projectId,
  letterId,
  canManage,
}: LinkedTasksPanelProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number] | ''>('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const key = ['correspondence', 'linkedTasks', letterId];
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => corrApi.listLinkedTasks(teamId, projectId, letterId),
  });

  const createMut = useMutation({
    mutationFn: () =>
      corrApi.createLinkedTask(teamId, projectId, letterId, {
        title: title.trim(),
        priority: priority || undefined,
        dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null,
      }),
    onSuccess: async () => {
      setTitle('');
      setPriority('');
      setDueDate('');
      setError(null);
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] });
    },
    onError: (err) => setError(corrApi.errorMessage(err, t('correspondence.linkedTasks.error'))),
  });

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-slate-600">{t('correspondence.linkedTasks.title')}</h3>

      {isLoading ? (
        <p className="text-xs text-slate-500">{t('common.loading')}</p>
      ) : tasks.length === 0 ? (
        <p className="text-xs text-slate-400 italic">{t('correspondence.linkedTasks.none')}</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((tk) => (
            <li key={tk.taskId} className="text-sm rounded border border-border px-2 py-1.5 flex items-center justify-between gap-2">
              <Link
                to={`/projects/${projectId}/tasks/${tk.taskId}`}
                className="text-primary hover:underline truncate"
              >
                {tk.title}
              </Link>
              <span className="text-[11px] text-slate-500 shrink-0">{tk.status}</span>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="rounded border border-border p-2 space-y-2 bg-bg-elevated">
          <p className="text-xs font-medium text-text-muted">{t('correspondence.linkedTasks.create')}</p>
          <input
            type="text"
            placeholder={t('correspondence.linkedTasks.titlePlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
          />
          <div className="flex items-center gap-2">
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number] | '')}
              className="rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
              aria-label={t('correspondence.linkedTasks.priority')}
            >
              <option value="">{t('correspondence.linkedTasks.noPriority')}</option>
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
              className="rounded border-border px-2 py-1 border text-sm dark:bg-slate-800"
              aria-label={t('correspondence.linkedTasks.dueDate')}
            />
          </div>
          {error && <p className="text-xs text-danger" role="alert">{error}</p>}
          <button
            type="button"
            onClick={() => createMut.mutate()}
            disabled={!title.trim() || createMut.isPending}
            className="text-xs rounded bg-primary text-white px-3 py-1.5 disabled:opacity-50"
          >
            {t('correspondence.linkedTasks.submit')}
          </button>
        </div>
      )}
    </div>
  );
}
