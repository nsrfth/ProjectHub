import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import * as projectsApi from '@/features/projects/api';
import * as tasksApi from '@/features/tasks/api';
import type { Task } from '@/features/tasks/api';
import { IconClose } from '@/features/nav/icons';
import {
  fetchDoneReport,
  fetchSummary,
  fetchTeamActivity,
  fetchUpcoming,
  fetchWorkload,
  type DoneReport,
  type DoneTaskRow,
  type SummaryReport,
  type TeamActivityRow,
  type UpcomingTaskRow,
  type WorkloadRow,
} from '@/features/reports/api';
import { useT } from '@/lib/i18n';

// v1.31: dashboard redesign per mockup. Layout:
//   row 1 — greeting (inline-start) + period selector (inline-end)
//   row 2 — four KPI cards, "Open tasks" accented as the primary metric
//   row 3 — completion-trend chart (2/3) + status breakdown (1/3)
//   row 4 — workload + upcoming deadlines + recent activity (3 columns)
//
// Period tabs only re-scope the trend chart (week/month/quarter). The
// snapshot KPIs come from /reports/summary which is fixed at 7-day
// last-week deltas — labels say "this week" / "as of now" so we don't
// imply more than we measure. Upcoming-deadlines + recent-activity
// panels are deliberately empty placeholders until v1.32 ships the
// per-user feed endpoints.

type Period = 'week' | 'month' | 'quarter';
const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30, quarter: 90 };

// v1.88: KPI drill-down. Each snapshot card maps to a task predicate; clicking
// it opens a modal listing the matching tasks (fetched lazily across all
// projects, then filtered client-side so the four lists stay mutually
// consistent).
type DrillKind = 'open' | 'overdue' | 'in_progress' | 'completed';
interface DrillRow {
  task: Task;
  projectName: string;
}
const DRILL_LABEL_KEY: Record<DrillKind, string> = {
  open: 'dashboard.kpi.open',
  overdue: 'dashboard.kpi.overdue',
  in_progress: 'dashboard.kpi.inProgress',
  completed: 'dashboard.kpi.completed',
};
function filterDrill(rows: DrillRow[], kind: DrillKind): DrillRow[] {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const sevenAgoMs = Date.now() - 7 * 86_400_000;
  const out = rows.filter(({ task }) => {
    switch (kind) {
      case 'open':
        return task.status !== 'DONE';
      case 'in_progress':
        return task.status === 'IN_PROGRESS';
      case 'overdue':
        return task.status !== 'DONE' && !!task.dueDate && new Date(task.dueDate).getTime() < todayMs;
      case 'completed':
        return (
          task.status === 'DONE' &&
          !!task.completedAt &&
          new Date(task.completedAt).getTime() >= sevenAgoMs
        );
    }
  });
  return out.sort((a, b) => {
    if (kind === 'completed') {
      return (b.task.completedAt ?? '').localeCompare(a.task.completedAt ?? '');
    }
    const ad = a.task.dueDate ?? '';
    const bd = b.task.dueDate ?? '';
    if (!ad && !bd) return 0;
    if (!ad) return 1;
    if (!bd) return -1;
    return ad.localeCompare(bd);
  });
}

export default function DashboardPage(): JSX.Element {
  const { user } = useAuth();
  const { teams, loading: teamsLoading, isError: teamsError } = useTeams();
  const t = useT();
  const [period, setPeriod] = useState<Period>('week');

  const summaryQueries = useQueries({
    queries: teams.map((tm) => ({
      queryKey: ['reports', 'summary', tm.id],
      queryFn: () => fetchSummary(tm.id),
    })),
  });
  const doneQueries = useQueries({
    queries: teams.map((tm) => ({
      queryKey: ['reports', 'done', tm.id, PERIOD_DAYS[period]],
      queryFn: () => fetchDoneReport(tm.id, PERIOD_DAYS[period]),
      staleTime: 60_000,
    })),
  });
  const workloadQueries = useQueries({
    queries: teams.map((tm) => ({
      queryKey: ['reports', 'workload', tm.id],
      queryFn: () => fetchWorkload(tm.id),
      staleTime: 60_000,
    })),
  });
  const upcomingQueries = useQueries({
    queries: teams.map((tm) => ({
      queryKey: ['reports', 'upcoming', tm.id],
      queryFn: () => fetchUpcoming(tm.id, 7),
      staleTime: 60_000,
    })),
  });
  const activityQueries = useQueries({
    queries: teams.map((tm) => ({
      queryKey: ['reports', 'activity', tm.id],
      queryFn: () => fetchTeamActivity(tm.id, 8),
      staleTime: 30_000,
    })),
  });

  const hasTeams = teams.length > 0;
  const summary = useMemo(
    () => mergeSummaries(summaryQueries.map((q) => q.data).filter(Boolean) as SummaryReport[]),
    [summaryQueries],
  );
  const done = useMemo(
    () => mergeDoneReports(doneQueries.map((q) => q.data).filter(Boolean) as DoneReport[]),
    [doneQueries],
  );
  const workload = useMemo(
    () => ({ items: mergeWorkload(workloadQueries.flatMap((q) => q.data?.items ?? [])) }),
    [workloadQueries],
  );
  const upcoming = useMemo(
    () => ({ items: mergeUpcoming(upcomingQueries.flatMap((q) => q.data?.items ?? [])) }),
    [upcomingQueries],
  );
  const activity = useMemo(
    () => ({ items: mergeActivity(activityQueries.flatMap((q) => q.data?.items ?? [])) }),
    [activityQueries],
  );

  const reportsLoading =
    hasTeams &&
    (summaryQueries.some((q) => q.isLoading) ||
      doneQueries.some((q) => q.isLoading) ||
      workloadQueries.some((q) => q.isLoading) ||
      upcomingQueries.some((q) => q.isLoading) ||
      activityQueries.some((q) => q.isLoading));

  // Shared sparkline series — last 7 days of completions. We don't have
  // per-metric histories, so every KPI card shows the same throughput
  // signal as a low-opacity background trend. The card's headline number
  // remains the authoritative datum.
  const daily = useMemo(
    () => buildDailyCounts(done?.items ?? [], 14),
    [done?.items],
  );
  const last7Total = daily.slice(-7).reduce((s, v) => s + v, 0);
  const prev7Total = daily.slice(-14, -7).reduce((s, v) => s + v, 0);
  const completedDelta = last7Total - prev7Total;

  // v1.88: drill-down state. Tasks are fetched only after a card is clicked
  // (shares the planner grid's ['tasks', teamId, projectId] cache).
  const [drill, setDrill] = useState<DrillKind | null>(null);
  const { data: drillProjects = [] } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: projectsApi.listAllProjects,
    enabled: drill !== null,
  });
  const drillTaskQs = useQueries({
    queries: (drill !== null ? drillProjects : []).map((p) => ({
      queryKey: ['tasks', p.teamId, p.id],
      queryFn: () => tasksApi.listTasks(p.teamId, p.id),
      staleTime: 30_000,
    })),
  });
  const drillLoading = drill !== null && drillTaskQs.some((q) => q.isLoading);
  const drillRows = useMemo<DrillRow[]>(() => {
    if (drill === null) return [];
    const rows = drillTaskQs.flatMap((q, i) => {
      const p = drillProjects[i];
      if (!p || !q.data) return [];
      return q.data.map((task) => ({ task, projectName: p.name }));
    });
    return filterDrill(rows, drill);
  }, [drill, drillTaskQs, drillProjects]);

  const greetingName = user?.name?.split(/\s+/)[0] ?? user?.email ?? '';

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Greeting + period tabs */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-text">
            {t('dashboard.greeting').replace('{name}', greetingName)}
          </h2>
          <p className="text-sm text-text-muted mt-1">
            {teamsLoading
              ? ''
              : hasTeams
                ? t('dashboard.allTeamsSubtitle').replace('{n}', String(teams.length))
                : t('dashboard.selectTeamHint')}
          </p>
        </div>
        <PeriodTabs value={period} onChange={setPeriod} />
      </div>

      {teamsError && !teamsLoading && (
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-6 text-sm text-danger">
          {t('dashboard.teamsLoadError')}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => window.location.reload()}
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      {!hasTeams && !teamsLoading && !teamsError && (
        <div className="bg-surface border border-border rounded-lg p-6 text-sm text-text">
          {t('dashboard.selectTeamHint')}{' '}
          <Link to="/teams" className="text-primary underline">
            {t('dashboard.manageTeams')}
          </Link>
        </div>
      )}

      {/* KPI cards. Open Tasks gets the primary accent. */}
      {hasTeams && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard
            label={t('dashboard.kpi.open')}
            value={summary?.openCount}
            spark={daily}
            accent="primary"
            onClick={() => setDrill('open')}
          />
          <KpiCard
            label={t('dashboard.kpi.overdue')}
            value={summary?.overdueCount}
            spark={daily}
            tone={(summary?.overdueCount ?? 0) > 0 ? 'danger' : 'neutral'}
            onClick={() => setDrill('overdue')}
          />
          <KpiCard
            label={t('dashboard.kpi.inProgress')}
            value={summary?.byStatus.IN_PROGRESS}
            spark={daily}
            onClick={() => setDrill('in_progress')}
          />
          <KpiCard
            label={t('dashboard.kpi.completed')}
            value={summary?.doneLast7Days}
            spark={daily}
            delta={completedDelta}
            deltaLabel={t('dashboard.kpi.delta')}
            onClick={() => setDrill('completed')}
          />
        </div>
      )}

      {/* Trend chart (2 cols) + status breakdown (1 col) */}
      {hasTeams && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Panel className="lg:col-span-2" title={t('dashboard.trend.title')}>
            {done && !reportsLoading ? (
              <BigTrend rows={done.items} days={PERIOD_DAYS[period]} t={t} />
            ) : (
              <Skeleton h={180} />
            )}
          </Panel>
          <Panel title={t('dashboard.statusBreakdown')}>
            {summary && !summaryQueries.some((q) => q.isLoading) ? (
              <StatusList byStatus={summary.byStatus} t={t} />
            ) : (
              <Skeleton h={180} />
            )}
          </Panel>
        </div>
      )}

      {/* Workload + upcoming + activity */}
      {hasTeams && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Panel title={t('dashboard.workload.title')} subtitle={t('dashboard.workload.subtitle')}>
            {workload && !workloadQueries.some((q) => q.isLoading) ? (
              <WorkloadList rows={workload.items} />
            ) : (
              <Skeleton h={150} />
            )}
          </Panel>
          <Panel title={t('dashboard.upcoming.title')}>
            {upcoming && !upcomingQueries.some((q) => q.isLoading) ? (
              <UpcomingList items={upcoming.items} t={t} />
            ) : (
              <Skeleton h={150} />
            )}
          </Panel>
          <Panel
            title={t('dashboard.activity.title')}
            action={
              <Link to="/reports" className="text-xs text-primary">
                {t('dashboard.activity.viewAll')}
              </Link>
            }
          >
            {activity && !activityQueries.some((q) => q.isLoading) ? (
              <ActivityList items={activity.items} t={t} />
            ) : (
              <Skeleton h={150} />
            )}
          </Panel>
        </div>
      )}

      {drill !== null && (
        <DrillModal
          kind={drill}
          rows={drillRows}
          loading={drillLoading}
          onClose={() => setDrill(null)}
          t={t}
        />
      )}
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────

function PeriodTabs({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}): JSX.Element {
  const t = useT();
  const items: Array<{ key: Period; label: string }> = [
    { key: 'quarter', label: t('dashboard.period.quarter') },
    { key: 'month', label: t('dashboard.period.month') },
    { key: 'week', label: t('dashboard.period.week') },
  ];
  return (
    <div className="inline-flex bg-bg-elevated rounded-lg p-1">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onChange(it.key)}
          className={[
            'px-3 py-1 text-xs rounded-md transition-colors',
            value === it.key
              ? 'bg-surface text-text shadow-sm'
              : 'text-text-muted hover:text-text',
          ].join(' ')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  spark,
  delta,
  deltaLabel,
  accent,
  tone,
  onClick,
}: {
  label: string;
  value: number | undefined;
  spark: number[];
  delta?: number;
  deltaLabel?: string;
  accent?: 'primary';
  tone?: 'danger' | 'neutral';
  onClick?: () => void;
}): JSX.Element {
  const isPrimary = accent === 'primary';
  const className = [
    'rounded-xl p-5 border text-start w-full',
    isPrimary
      ? 'bg-primary text-primary-contrast border-primary'
      : 'bg-surface border-border',
    onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : '',
  ].join(' ');
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p
          className={[
            'text-xs',
            isPrimary ? 'text-indigo-100' : 'text-text-muted',
          ].join(' ')}
        >
          {label}
        </p>
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <p
          className={[
            'text-3xl font-semibold tabular-nums',
            isPrimary
              ? 'text-primary-contrast'
              : tone === 'danger'
                ? 'text-danger'
                : 'text-text',
          ].join(' ')}
        >
          {value ?? '—'}
        </p>
        <div className="w-24 h-7 text-current">
          <Sparkline
            data={spark}
            className={isPrimary ? 'text-indigo-200' : 'text-indigo-400/70'}
          />
        </div>
      </div>
      {typeof delta === 'number' && (
        <p
          className={[
            'mt-2 text-[11px]',
            isPrimary
              ? 'text-indigo-100'
              : delta > 0
                ? 'text-success'
                : delta < 0
                  ? 'text-danger'
                  : 'text-slate-500',
          ].join(' ')}
        >
          {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)}
          {deltaLabel ? ` ${deltaLabel}` : ''}
        </p>
      )}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  ) : (
    <div className={className}>{inner}</div>
  );
}

// v1.88: KPI drill-down modal — lists the tasks behind a snapshot card.
function DrillModal({
  kind,
  rows,
  loading,
  onClose,
  t,
}: {
  kind: DrillKind;
  rows: DrillRow[];
  loading: boolean;
  onClose: () => void;
  t: (k: string) => string;
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 overflow-y-auto">
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className="fixed inset-0 bg-slate-900/50"
      />
      <div className="relative bg-surface text-text rounded-xl shadow-xl w-full max-w-xl mt-4">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="font-semibold">
            {t(DRILL_LABEL_KEY[kind])}
            {!loading && <span className="ms-2 text-sm text-text-muted">({rows.length})</span>}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 rounded text-text-muted hover:bg-bg-elevated"
          >
            <IconClose size={20} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-2">
          {loading && (
            <p className="text-sm text-text-muted p-4 text-center">…</p>
          )}
          {!loading && rows.length === 0 && (
            <p className="text-sm text-text-muted italic p-6 text-center">
              {t('dashboard.drill.empty')}
            </p>
          )}
          {!loading && rows.length > 0 && (
            <ul className="divide-y divide-border">
              {rows.map(({ task, projectName }) => (
                <li key={task.id}>
                  <Link
                    to={`/projects/${task.projectId}/tasks/${task.id}`}
                    onClick={onClose}
                    className="block px-3 py-2 rounded hover:bg-bg-elevated"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate min-w-0 flex-1">
                        {task.title}
                      </span>
                      {kind === 'completed'
                        ? task.completedAt && (
                            <span className="text-xs text-text-muted shrink-0" dir="ltr">
                              {task.completedAt.slice(0, 10)}
                            </span>
                          )
                        : task.dueDate && (
                            <span
                              className={`text-xs shrink-0 ${
                                kind === 'overdue' ? 'text-danger' : 'text-text-muted'
                              }`}
                              dir="ltr"
                            >
                              {task.dueDate.slice(0, 10)}
                            </span>
                          )}
                    </div>
                    <p className="text-xs text-text-muted truncate">{projectName}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Sparkline({ data, className }: { data: number[]; className?: string }): JSX.Element | null {
  if (data.length < 2) return null;
  const max = Math.max(1, ...data);
  const W = 100;
  const H = 28;
  const step = W / (data.length - 1);
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * H).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={['w-full h-full', className].filter(Boolean).join(' ')}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Panel({
  title,
  subtitle,
  action,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className={[
        'bg-surface border border-border rounded-xl p-5',
        className ?? '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text">{title}</h3>
          {subtitle && (
            <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const STATUS_COLORS: Record<string, string> = {
  TODO: '#94a3b8',
  IN_PROGRESS: '#f59e0b',
  REVIEW: '#06b6d4',
  PENDING_APPROVAL: '#a855f7',
  DONE: '#10b981',
};

function StatusList({
  byStatus,
  t,
}: {
  byStatus: {
    TODO: number;
    IN_PROGRESS: number;
    REVIEW: number;
    PENDING_APPROVAL: number;
    DONE: number;
  };
  t: (k: string) => string;
}): JSX.Element {
  const order = ['TODO', 'IN_PROGRESS', 'REVIEW', 'PENDING_APPROVAL', 'DONE'] as const;
  const total = order.reduce((s, k) => s + byStatus[k], 0) || 1;
  return (
    <ul className="space-y-3">
      {order.map((k) => {
        const v = byStatus[k];
        const pct = Math.round((v / total) * 100);
        return (
          <li key={k} className="flex items-center gap-3 text-sm">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: STATUS_COLORS[k] }}
              aria-hidden
            />
            <span className="flex-1 text-text">
              {t(`dashboard.status.${k}`)}
            </span>
            <span className="tabular-nums text-text font-medium">
              {v}
            </span>
            <span className="tabular-nums text-xs text-slate-400 w-9 text-end">{pct}%</span>
          </li>
        );
      })}
    </ul>
  );
}

function BigTrend({
  rows,
  days,
  t,
}: {
  rows: DoneTaskRow[];
  days: number;
  t: (k: string) => string;
}): JSX.Element {
  const series = buildDailySeries(rows, days);
  const max = Math.max(1, ...series.map((s) => Math.max(s.count, s.avg)));
  const W = 720;
  const H = 200;
  const padX = 12;
  const padY = 12;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const barW = innerW / series.length;
  const line = series
    .map((s, i) => {
      const x = padX + i * barW + barW / 2;
      const y = padY + innerH - (s.avg / max) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const total = series.reduce((s, x) => s + x.count, 0);
  const last7 = series.slice(-7).reduce((s, x) => s + x.count, 0);
  const prev7 = series.slice(-14, -7).reduce((s, x) => s + x.count, 0);
  const delta = last7 - prev7;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>
          <span className="tabular-nums text-text font-semibold">
            {total}
          </span>{' '}
          {t('dashboard.trend.total').replace('{n}', '').trim()}
        </span>
        <span
          className={
            delta > 0
              ? 'text-success'
              : delta < 0
                ? 'text-danger'
                : ''
          }
        >
          {delta >= 0 ? '+' : ''}
          {delta} {t('dashboard.kpi.delta')}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        preserveAspectRatio="none"
        aria-label="Completion trend"
      >
        {series.map((s, i) => {
          const h = (s.count / max) * innerH;
          return (
            <rect
              key={s.key}
              x={padX + i * barW + 1.5}
              y={padY + innerH - h}
              width={Math.max(0, barW - 3)}
              height={h}
              rx={2}
              className="fill-indigo-400/80 dark:fill-indigo-500/80"
            >
              <title>{`${s.key}: ${s.count}`}</title>
            </rect>
          );
        })}
        <polyline
          points={line}
          fill="none"
          className="stroke-indigo-200 dark:stroke-indigo-200/70"
          strokeWidth="1.5"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400">
        <span>{series[0]?.label}</span>
        <span>{series[Math.floor(series.length / 2)]?.label}</span>
        <span>{series[series.length - 1]?.label}</span>
      </div>
    </div>
  );
}

const PERSON_COLORS = ['#a855f7', '#f97316', '#facc15', '#ef4444', '#10b981', '#0ea5e9'];

function WorkloadList({ rows }: { rows: WorkloadRow[] }): JSX.Element {
  const sorted = [...rows].sort((a, b) => b.total - a.total).slice(0, 5);
  const max = Math.max(1, ...sorted.map((r) => r.total));
  if (sorted.length === 0) {
    return <EmptyHint text="—" />;
  }
  return (
    <ul className="space-y-3">
      {sorted.map((r, idx) => {
        const total = r.total || 1;
        return (
          <li key={r.assigneeId ?? `u${idx}`} className="flex items-center gap-3">
            <span
              className="w-8 h-8 rounded-full text-white text-[11px] font-semibold flex items-center justify-center shrink-0"
              style={{ background: PERSON_COLORS[idx % PERSON_COLORS.length] }}
            >
              {(r.assigneeName ?? '?').slice(0, 2)}
            </span>
            <span className="text-sm text-text flex-1 truncate">
              {r.assigneeName ?? 'unassigned'}
            </span>
            <span className="tabular-nums text-sm text-text font-medium w-6 text-end">
              {r.total}
            </span>
            <div
              className="h-2 rounded-full bg-bg-elevated overflow-hidden flex"
              style={{ width: `${Math.max(20, (r.total / max) * 60)}%` }}
              aria-hidden
            >
              <Seg v={r.byStatus.IN_PROGRESS} t={total} color="#f97316" />
              <Seg v={r.byStatus.REVIEW} t={total} color="#06b6d4" />
              <Seg v={r.byStatus.TODO} t={total} color="#94a3b8" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Seg({ v, t, color }: { v: number; t: number; color: string }): JSX.Element | null {
  if (v <= 0) return null;
  return <span style={{ background: color, flex: v / t }} />;
}

const PRIORITY_STYLES: Record<string, string> = {
  URGENT: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  HIGH: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  MEDIUM: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  LOW: 'bg-slate-100 text-slate-500 dark:bg-slate-700/60 dark:text-slate-400',
};

function UpcomingList({
  items,
  t,
}: {
  items: UpcomingTaskRow[];
  t: (k: string) => string;
}): JSX.Element {
  if (items.length === 0) {
    return <EmptyHint text={t('dashboard.upcoming.empty')} />;
  }
  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.taskId} className="flex items-center gap-3">
          <span className="flex-1 min-w-0">
            <Link
              to={`/projects/${it.projectId}/tasks/${it.taskId}`}
              className="block text-sm text-text truncate hover:underline"
            >
              {it.taskTitle}
            </Link>
            <span className="block text-xs text-text-muted truncate">
              {it.projectName}
            </span>
          </span>
          <span
            className={[
              'shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded',
              PRIORITY_STYLES[it.priority] ?? PRIORITY_STYLES.MEDIUM,
            ].join(' ')}
          >
            {dueLabel(it.daysUntil, t)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function dueLabel(daysUntil: number, t: (k: string) => string): string {
  if (daysUntil <= 0) return t('dashboard.upcoming.today');
  if (daysUntil === 1) return t('dashboard.upcoming.tomorrow');
  return t('dashboard.upcoming.inDays').replace('{n}', String(daysUntil));
}

function ActivityList({
  items,
  t,
}: {
  items: TeamActivityRow[];
  t: (k: string) => string;
}): JSX.Element {
  if (items.length === 0) {
    return <EmptyHint text="—" />;
  }
  return (
    <ul className="space-y-3">
      {items.map((a) => (
        <li key={a.id} className="flex items-start gap-3">
          <span className="w-7 h-7 rounded-full bg-bg-elevated text-text-muted text-[10px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
            {(a.actorName || '?').slice(0, 2)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-text">
              <span className="font-medium">{a.actorName}</span>{' '}
              <span className="text-text-muted">
                {actionVerb(a.action, t)}
              </span>
              {a.taskTitle && (
                <span className="text-text">
                  {' '}
                  «{a.taskTitle}»
                </span>
              )}
            </span>
            <span className="block text-xs text-text-muted">
              {relativeTime(a.createdAt)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// Map the activity `action` slug to a short human verb. Unknown actions fall
// back to the raw slug so new event types still render (just less prettily).
const KNOWN_VERBS = new Set([
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.assigned',
  'task.deleted',
  'comment.created',
]);
function actionVerb(action: string, t: (k: string) => string): string {
  if (KNOWN_VERBS.has(action)) return t(`activity.verb.${action}`);
  return action.replace(/[._]/g, ' ');
}

// Compact relative time. Avoids pulling in a date library for one widget.
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

function EmptyHint({ text }: { text: string }): JSX.Element {
  return (
    <p className="text-sm text-text-muted italic py-6 text-center">
      {text}
    </p>
  );
}

function Skeleton({ h }: { h: number }): JSX.Element {
  return (
    <div
      className="w-full rounded bg-bg-elevated animate-pulse"
      style={{ height: h }}
    />
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function mergeSummaries(rows: SummaryReport[]): SummaryReport | undefined {
  if (rows.length === 0) return undefined;
  const merged: SummaryReport = {
    doneLast7Days: 0,
    overdueCount: 0,
    openCount: 0,
    byStatus: { TODO: 0, IN_PROGRESS: 0, REVIEW: 0, PENDING_APPROVAL: 0, DONE: 0 },
  };
  for (const s of rows) {
    merged.doneLast7Days += s.doneLast7Days;
    merged.overdueCount += s.overdueCount;
    merged.openCount += s.openCount;
    merged.byStatus.TODO += s.byStatus.TODO;
    merged.byStatus.IN_PROGRESS += s.byStatus.IN_PROGRESS;
    merged.byStatus.REVIEW += s.byStatus.REVIEW;
    merged.byStatus.PENDING_APPROVAL += s.byStatus.PENDING_APPROVAL;
    merged.byStatus.DONE += s.byStatus.DONE;
  }
  return merged;
}

function mergeDoneReports(reports: DoneReport[]): DoneReport | undefined {
  if (reports.length === 0) return undefined;
  const byTask = new Map<string, DoneTaskRow>();
  for (const r of reports) {
    for (const item of r.items) byTask.set(item.taskId, item);
  }
  return {
    windowDays: Math.max(...reports.map((r) => r.windowDays)),
    items: [...byTask.values()],
  };
}

function mergeWorkload(rows: WorkloadRow[]): WorkloadRow[] {
  const byAssignee = new Map<string, WorkloadRow>();
  for (const r of rows) {
    const key = r.assigneeId ?? '__unassigned__';
    const existing = byAssignee.get(key);
    if (!existing) {
      byAssignee.set(key, {
        assigneeId: r.assigneeId,
        assigneeName: r.assigneeName,
        total: r.total,
        byStatus: { ...r.byStatus },
      });
      continue;
    }
    existing.total += r.total;
    existing.byStatus.TODO += r.byStatus.TODO;
    existing.byStatus.IN_PROGRESS += r.byStatus.IN_PROGRESS;
    existing.byStatus.REVIEW += r.byStatus.REVIEW;
    if (!existing.assigneeName && r.assigneeName) existing.assigneeName = r.assigneeName;
  }
  return [...byAssignee.values()];
}

function mergeUpcoming(items: UpcomingTaskRow[]): UpcomingTaskRow[] {
  const byTask = new Map<string, UpcomingTaskRow>();
  for (const item of items) {
    const prev = byTask.get(item.taskId);
    if (!prev || item.daysUntil < prev.daysUntil) byTask.set(item.taskId, item);
  }
  return [...byTask.values()]
    .sort((a, b) => a.daysUntil - b.daysUntil || a.dueDate.localeCompare(b.dueDate))
    .slice(0, 10);
}

function mergeActivity(items: TeamActivityRow[]): TeamActivityRow[] {
  const byId = new Map<string, TeamActivityRow>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);
}

function buildDailyCounts(rows: DoneTaskRow[], days: number): number[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const counts: number[] = new Array(days).fill(0);
  for (const r of rows) {
    const d = new Date(r.completedAt);
    d.setUTCHours(0, 0, 0, 0);
    const diff = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
    if (diff >= 0 && diff < days) counts[days - 1 - diff] = (counts[days - 1 - diff] ?? 0) + 1;
  }
  return counts;
}

interface DaySlot {
  key: string;
  label: string;
  count: number;
  avg: number;
}

function buildDailySeries(rows: DoneTaskRow[], days: number): DaySlot[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const window: DaySlot[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    window.push({
      key: d.toISOString().slice(0, 10),
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      count: 0,
      avg: 0,
    });
  }
  const byKey = new Map(window.map((w) => [w.key, w]));
  for (const r of rows) {
    const slot = byKey.get(r.completedAt.slice(0, 10));
    if (slot) slot.count += 1;
  }
  // 7-day trailing moving average.
  for (let i = 0; i < window.length; i++) {
    const start = Math.max(0, i - 6);
    const slice = window.slice(start, i + 1);
    window[i]!.avg = slice.reduce((s, x) => s + x.count, 0) / slice.length;
  }
  return window;
}
