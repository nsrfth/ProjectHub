import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import { listProjects } from '@/features/projects/api';
import { listTasks } from '@/features/tasks/api';
import * as ts from '@/features/timesheets/api';
import { RateCardsSection } from '@/features/timesheets/RateCardsSection';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

function statusTone(status: ts.TimesheetStatus): string {
  switch (status) {
    case 'APPROVED':
      return 'text-success';
    case 'REJECTED':
      return 'text-danger';
    case 'SUBMITTED':
      return 'text-warning';
    default:
      return 'text-text-muted';
  }
}

export default function TimesheetsPage(): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const { teams, currentTeamId, setCurrentTeamId } = useTeams();
  const teamId = currentTeamId ?? teams[0]?.id ?? null;
  const team = teams.find((tm) => tm.id === teamId) ?? null;
  const canApprove = team?.myRole === 'MANAGER';

  const { data: projects = [] } = useQuery({
    queryKey: ['ts', 'projects', teamId],
    queryFn: () => listProjects(teamId!),
    enabled: !!teamId,
  });
  const { data: entries = [] } = useQuery({
    queryKey: ['ts', 'entries', teamId],
    queryFn: () => ts.listTimeEntries(teamId!),
    enabled: !!teamId,
  });
  const { data: myPeriods = [] } = useQuery({
    queryKey: ['ts', 'periods', teamId],
    queryFn: () => ts.listPeriods(teamId!),
    enabled: !!teamId,
  });

  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [billable, setBillable] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState('1');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const { data: projectTasks = [] } = useQuery({
    queryKey: ['ts', 'tasks', teamId, projectId],
    queryFn: () => listTasks(teamId!, projectId),
    enabled: !!teamId && !!projectId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ts'] });

  const logMut = useMutation({
    mutationFn: () =>
      ts.createTimeEntry(teamId!, {
        projectId,
        taskId: taskId || undefined,
        date,
        minutes: Math.round(parseFloat(hours || '0') * 60),
        billable,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setNote('');
      setTaskId('');
      setBillable(false);
      setErr(null);
      void invalidate();
    },
    onError: (e) => setErr(errorMessage(e, t('timesheets.logFailed'))),
  });

  const periodMut = useMutation({
    mutationFn: () => {
      const d = new Date(`${date}T00:00:00Z`);
      const dow = (d.getUTCDay() + 6) % 7; // Monday-based
      const start = new Date(d);
      start.setUTCDate(d.getUTCDate() - dow);
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 6);
      return ts.ensurePeriod(teamId!, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    },
    onSuccess: invalidate,
  });
  const submitMut = useMutation({ mutationFn: (id: string) => ts.submitPeriod(teamId!, id), onSuccess: invalidate });
  const approveMut = useMutation({ mutationFn: (id: string) => ts.approvePeriod(teamId!, id), onSuccess: invalidate });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => ts.rejectPeriod(teamId!, id, reason),
    onSuccess: invalidate,
  });
  const reopenMut = useMutation({ mutationFn: (id: string) => ts.reopenPeriod(teamId!, id), onSuccess: invalidate });
  const delMut = useMutation({ mutationFn: (id: string) => ts.deleteTimeEntry(teamId!, id), onSuccess: invalidate });

  const { data: approvalQueue = [] } = useQuery({
    queryKey: ['ts', 'queue', teamId],
    queryFn: async () => (await ts.listPeriods(teamId!)).filter((p) => p.status === 'SUBMITTED'),
    enabled: !!teamId && canApprove,
  });

  const totalHours = useMemo(
    () => (entries.reduce((s, e) => s + e.minutes, 0) / 60).toFixed(1),
    [entries],
  );

  function onLog(e: FormEvent) {
    e.preventDefault();
    if (!projectId) {
      setErr(t('timesheets.pickProject'));
      return;
    }
    logMut.mutate();
  }

  if (!teamId) {
    return <div className="p-6 text-text-muted">{t('timesheets.noTeam')}</div>;
  }

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('timesheets.title')}</h1>
        <select
          className="rounded border border-border bg-surface px-2 py-1 text-sm"
          value={teamId}
          onChange={(e) => setCurrentTeamId(e.target.value)}
        >
          {teams.map((tm) => (
            <option key={tm.id} value={tm.id}>
              {tm.name}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={onLog} className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-medium">{t('timesheets.logTime')}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            {t('timesheets.project')}
            <select
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm text-text"
              value={projectId}
              onChange={(e) => { setProjectId(e.target.value); setTaskId(''); }}
            >
              <option value="">{t('timesheets.pickProject')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            {t('timesheets.task')}
            <select
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm text-text"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              disabled={!projectId}
            >
              <option value="">{t('timesheets.noTask')}</option>
              {projectTasks.map((tk) => (
                <option key={tk.id} value={tk.id}>
                  {tk.title}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            {t('timesheets.date')}
            <input type="date" className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="text-xs text-text-muted">
            {t('timesheets.hours')}
            <input type="number" min="0.25" step="0.25" className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm" value={hours} onChange={(e) => setHours(e.target.value)} />
          </label>
          <label className="text-xs text-text-muted">
            {t('timesheets.note')}
            <input className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-text-muted cursor-pointer">
          <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
          {t('timesheets.billable')}
        </label>
        {err && <p className="text-xs text-danger">{err}</p>}
        <button type="submit" disabled={logMut.isPending} className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {t('timesheets.addEntry')}
        </button>
      </form>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">{t('timesheets.myEntries')}</h2>
          <span className="text-xs text-text-muted">{t('timesheets.totalHours')}: {totalHours}</span>
        </div>
        {entries.length === 0 ? (
          <p className="text-xs text-text-muted">{t('timesheets.noEntries')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted">
                <th className="py-1">{t('timesheets.date')}</th>
                <th>{t('timesheets.project')}</th>
                <th className="text-right">{t('timesheets.hours')}</th>
                <th>{t('timesheets.status')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="py-1">{e.date}</td>
                  <td>{e.projectName ?? e.projectId}</td>
                  <td className="text-right">{e.hours}</td>
                  <td className={statusTone(e.status)}>{t(`timesheets.state.${e.status}`)}</td>
                  <td className="text-right">
                    {e.status === 'OPEN' || e.status === 'REOPENED' ? (
                      <button type="button" className="text-xs text-danger hover:underline" onClick={() => delMut.mutate(e.id)}>
                        {t('common.delete')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">{t('timesheets.periods')}</h2>
          <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-hover" onClick={() => periodMut.mutate()}>
            {t('timesheets.openWeek')}
          </button>
        </div>
        {myPeriods.length === 0 ? (
          <p className="text-xs text-text-muted">{t('timesheets.noPeriods')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {myPeriods.map((p) => (
              <li key={p.id} className="flex items-center justify-between border-t border-border py-1">
                <span>
                  {p.periodStart} → {p.periodEnd}{' '}
                  <span className={statusTone(p.status)}>({t(`timesheets.state.${p.status}`)})</span>{' '}
                  <span className="text-xs text-text-muted">{(p.totalMinutes / 60).toFixed(1)}h</span>
                </span>
                {(p.status === 'OPEN' || p.status === 'REOPENED') && (
                  <button type="button" className="text-xs text-primary hover:underline" onClick={() => submitMut.mutate(p.id)}>
                    {t('timesheets.submit')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canApprove && <RateCardsSection teamId={teamId} canManage={canApprove} />}

      {canApprove && (
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-medium">{t('timesheets.approvalQueue')}</h2>
          {approvalQueue.length === 0 ? (
            <p className="text-xs text-text-muted">{t('timesheets.queueEmpty')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {approvalQueue.map((p) => (
                <li key={p.id} className="flex items-center justify-between border-t border-border py-1">
                  <span>
                    {p.userName ?? p.userId} · {p.periodStart} → {p.periodEnd} · {(p.totalMinutes / 60).toFixed(1)}h
                  </span>
                  <span className="flex gap-2">
                    <button type="button" className="text-xs text-success hover:underline" onClick={() => approveMut.mutate(p.id)}>
                      {t('timesheets.approve')}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-danger hover:underline"
                      onClick={() => {
                        const reason = window.prompt(t('timesheets.rejectPrompt'));
                        if (reason && reason.trim()) rejectMut.mutate({ id: p.id, reason: reason.trim() });
                      }}
                    >
                      {t('timesheets.reject')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-text-muted">{t('timesheets.reopenHint')}</p>
          {myPeriods.filter((p) => p.status === 'APPROVED' || p.status === 'REJECTED').map((p) => (
            <button key={p.id} type="button" className="mr-2 mt-1 text-xs text-primary hover:underline" onClick={() => reopenMut.mutate(p.id)}>
              {t('timesheets.reopen')}: {p.periodStart}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
