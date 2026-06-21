import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import {
  downloadReportCsv,
  fetchBudgetReport,
  fetchDoneReport,
  fetchOverdue,
  fetchSummary,
  fetchTimeliness,
  fetchWorkload,
  type BudgetReport,
  type DoneReport,
  type DoneTaskRow,
  type OverdueTaskRow,
  type SummaryReport,
  type TimelinessReport,
  type WorkloadRow,
} from '@/features/reports/api';
import {
  mergeBudget,
  mergeDoneReports,
  mergeOverdue,
  mergeSummaries,
  mergeTimeliness,
  mergeWorkload,
} from '@/features/reports/aggregate';
import { formatShamsiDate, formatShamsiTimestampDate } from '@/lib/shamsi';
import { budgetLocaleFromLanguage, formatBudget, type BudgetCurrency } from '@/lib/formatBudget';
import { getLanguage, useT } from '@/lib/i18n';

const WINDOWS: { days: number; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

// v1.88: team selector. Either a specific team id, or 'all' to fan the
// per-team report queries out across every team the user belongs to and merge
// the results client-side (see features/reports/aggregate.ts) — mirrors the
// Calendar page's cross-team pattern, no new backend endpoint.
const ALL_TEAMS = 'all' as const;
type TeamSelection = typeof ALL_TEAMS | string;
const TEAM_STORAGE_KEY = 'reports.selectedTeam';

// "Tasks completed" report. Pulls the recently-completed tasks from the API
// and presents them two ways: a flat list (most recent first) and a per-
// assignee tally. Both pivots come from one merged query set.
export default function ReportsPage(): JSX.Element {
  const { teams, currentTeam } = useTeams();
  const nav = useNavigate();
  const t = useT();
  const budgetLocale = budgetLocaleFromLanguage(getLanguage());
  const [days, setDays] = useState<number>(7);

  // v1.88: persist the team selection (specific team or "All teams"), and
  // fall back to the current team if the stored id is no longer accessible.
  const [selectedTeam, setSelectedTeam] = useState<TeamSelection>(() => {
    if (typeof window === 'undefined') return currentTeam?.id ?? ALL_TEAMS;
    return window.localStorage.getItem(TEAM_STORAGE_KEY) ?? currentTeam?.id ?? ALL_TEAMS;
  });
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem(TEAM_STORAGE_KEY, selectedTeam);
  }, [selectedTeam]);
  useEffect(() => {
    if (selectedTeam === ALL_TEAMS || teams.length === 0) return;
    if (!teams.some((tm) => tm.id === selectedTeam)) {
      setSelectedTeam(currentTeam?.id ?? ALL_TEAMS);
    }
  }, [teams, selectedTeam, currentTeam?.id]);

  const isAllTeams = selectedTeam === ALL_TEAMS;
  const scopeTeams = useMemo(
    () => (isAllTeams ? teams : teams.filter((tm) => tm.id === selectedTeam)),
    [isAllTeams, teams, selectedTeam],
  );
  // The single team whose id powers the per-team CSV export (export stays
  // single-team only — the endpoints are per-team). null when "All teams".
  const singleTeam = isAllTeams ? null : scopeTeams[0] ?? null;

  // One query per in-scope team for each report; merged below. React Query
  // caches each per-team feed independently so switching scope reuses them.
  const doneQs = useQueries({
    queries: scopeTeams.map((tm) => ({
      queryKey: ['reports', 'done', tm.id, days],
      queryFn: () => fetchDoneReport(tm.id, days),
      staleTime: 60_000,
    })),
  });
  const summaryQs = useQueries({
    queries: scopeTeams.map((tm) => ({
      queryKey: ['reports', 'summary', tm.id],
      queryFn: () => fetchSummary(tm.id),
      staleTime: 60_000,
    })),
  });
  const workloadQs = useQueries({
    queries: scopeTeams.map((tm) => ({
      queryKey: ['reports', 'workload', tm.id],
      queryFn: () => fetchWorkload(tm.id),
      staleTime: 60_000,
    })),
  });
  const overdueQs = useQueries({
    queries: scopeTeams.map((tm) => ({
      queryKey: ['reports', 'overdue', tm.id],
      queryFn: () => fetchOverdue(tm.id),
      staleTime: 60_000,
    })),
  });
  const timelinessQs = useQueries({
    queries: scopeTeams.map((tm) => ({
      queryKey: ['reports', 'timeliness', tm.id, days],
      queryFn: () => fetchTimeliness(tm.id, days),
      staleTime: 60_000,
    })),
  });
  const budgetQs = useQueries({
    queries: scopeTeams.map((tm) => ({
      queryKey: ['reports', 'budget', tm.id],
      queryFn: () => fetchBudgetReport(tm.id),
      staleTime: 60_000,
    })),
  });

  const isLoading = doneQs.some((q) => q.isLoading);
  const data = useMemo(() => {
    const g = doneQs.map((q) => q.data).filter(Boolean) as DoneReport[];
    return g.length ? mergeDoneReports(g) : undefined;
  }, [doneQs]);
  const summary = useMemo(() => {
    const g = summaryQs.map((q) => q.data).filter(Boolean) as SummaryReport[];
    return g.length ? mergeSummaries(g) : undefined;
  }, [summaryQs]);
  const workload = useMemo(() => {
    const g = workloadQs.map((q) => q.data).filter(Boolean) as { items: WorkloadRow[] }[];
    return g.length ? mergeWorkload(g) : undefined;
  }, [workloadQs]);
  const overdue = useMemo(() => {
    const g = overdueQs.map((q) => q.data).filter(Boolean) as { items: OverdueTaskRow[] }[];
    return g.length ? mergeOverdue(g) : undefined;
  }, [overdueQs]);
  const timeliness = useMemo(() => {
    const g = timelinessQs.map((q) => q.data).filter(Boolean) as TimelinessReport[];
    return g.length ? mergeTimeliness(g) : undefined;
  }, [timelinessQs]);
  const budget = useMemo(() => {
    const g = budgetQs.map((q) => q.data).filter(Boolean) as BudgetReport[];
    return g.length ? mergeBudget(g) : undefined;
  }, [budgetQs]);

  const fmtMoney = (amount: string | null, currency: BudgetCurrency) =>
    formatBudget(amount, currency, budgetLocale);

  // Group by assignee name for the leaderboard pivot.
  const byAssignee = useMemo(() => {
    const m = new Map<string, { name: string; rows: DoneTaskRow[] }>();
    for (const r of data?.items ?? []) {
      const key = r.assigneeName ?? '(unassigned)';
      let entry = m.get(key);
      if (!entry) {
        entry = { name: key, rows: [] };
        m.set(key, entry);
      }
      entry.rows.push(r);
    }
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [data]);

  if (teams.length === 0) {
    return (
      <div className="min-h-screen p-8">
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

  return (
    <div className="p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-sm text-slate-500">
            {isAllTeams ? (
              t('reports.allTeams')
            ) : (
              <>
                in <span className="font-medium">{singleTeam?.name}</span>
              </>
            )}
          </p>
        </div>
        <label className="text-sm">
          <span className="me-2 text-slate-500">{t('reports.team')}</span>
          <select
            value={selectedTeam}
            onChange={(e) => setSelectedTeam(e.target.value)}
            className="rounded border border-slate-300 bg-surface px-3 py-1.5 text-sm"
          >
            <option value={ALL_TEAMS}>{t('reports.allTeams')}</option>
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Status snapshot — four small counters above the detailed sections. */}
      {summary && (
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="bg-white rounded shadow p-3">
            <p className="text-xs text-slate-500 uppercase tracking-wide">Open</p>
            <p className="text-2xl font-semibold tabular-nums">{summary.openCount}</p>
          </div>
          <div className="bg-white rounded shadow p-3">
            <p className="text-xs text-slate-500 uppercase tracking-wide">In progress</p>
            <p className="text-2xl font-semibold tabular-nums">{summary.byStatus.IN_PROGRESS}</p>
          </div>
          <div className="bg-white rounded shadow p-3">
            <p className="text-xs text-slate-500 uppercase tracking-wide">Done (7d)</p>
            <p className="text-2xl font-semibold tabular-nums text-success">
              {summary.doneLast7Days}
            </p>
          </div>
          <div className="bg-white rounded shadow p-3">
            <p className="text-xs text-slate-500 uppercase tracking-wide">Overdue</p>
            <p
              className={`text-2xl font-semibold tabular-nums ${
                summary.overdueCount > 0 ? 'text-danger' : 'text-text'
              }`}
            >
              {summary.overdueCount}
            </p>
          </div>
        </section>
      )}

      <section className="bg-white rounded shadow p-4 mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <h2 className="font-medium me-3">Tasks completed</h2>
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              className={`text-xs rounded px-2 py-1 border ${
                w.days === days ? 'bg-slate-900 text-white' : 'border-slate-300'
              }`}
            >
              {w.label}
            </button>
          ))}
          {data && (
            <span className="ms-auto text-sm text-slate-500">
              {data.items.length} task{data.items.length === 1 ? '' : 's'}
            </span>
          )}
          {singleTeam && (
            <button
              type="button"
              onClick={() =>
                downloadReportCsv(singleTeam.id, 'done', `tasks-done-${days}d`, { days })
              }
              className="text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
              title="Download as CSV"
            >
              Export CSV
            </button>
          )}
        </div>

        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {!isLoading && data && data.items.length === 0 && (
          <p className="text-sm text-slate-500 italic">
            No tasks completed in this window yet.
          </p>
        )}

        {data && data.items.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-2">
              <h3 className="text-sm font-medium mb-2 text-slate-600">All tasks</h3>
              <ul className="divide-y">
                {data.items.map((r) => (
                  <li key={r.taskId} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => nav(`/projects/${r.projectId}/tasks/${r.taskId}`)}
                        className="text-start font-medium hover:underline truncate min-w-0 flex-1"
                      >
                        {r.taskTitle}
                      </button>
                      <span className="text-xs text-slate-500" dir="rtl">
                        {formatShamsiTimestampDate(r.completedAt)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {r.projectName}
                      {r.assigneeName && <> · {r.assigneeName}</>}
                      {!r.assigneeName && <> · unassigned</>}
                    </p>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2 text-slate-600">By assignee</h3>
              <ul className="space-y-1">
                {byAssignee.map((g) => (
                  <li
                    key={g.name}
                    className="flex items-center justify-between text-sm border-b last:border-0 py-1"
                  >
                    <span>{g.name}</span>
                    <span className="text-xs text-slate-500 tabular-nums">{g.rows.length}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>

      {/* Timeliness — planned-vs-actual delivery quality over the same window. */}
      <section className="bg-white rounded shadow p-4 mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h2 className="font-medium me-3">Timeliness</h2>
          <span className="text-xs text-slate-500">
            (same window as "Tasks completed")
          </span>
          {singleTeam && (
            <button
              type="button"
              onClick={() =>
                downloadReportCsv(singleTeam.id, 'timeliness', `timeliness-${days}d`, { days })
              }
              className="ms-auto text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
              title="Download as CSV"
            >
              Export CSV
            </button>
          )}
        </div>
        {!timeliness && <p className="text-sm text-slate-500">Loading…</p>}
        {timeliness && timeliness.evaluatedCount === 0 && (
          <p className="text-sm text-slate-500 italic">
            No tasks in this window have both a planned date and a completion date yet.
          </p>
        )}
        {timeliness && timeliness.evaluatedCount > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">On-time rate</p>
              <p
                className={`text-2xl font-semibold tabular-nums ${
                  timeliness.onTimeRate >= 0.8
                    ? 'text-success'
                    : timeliness.onTimeRate >= 0.5
                      ? 'text-warning'
                      : 'text-danger'
                }`}
              >
                {Math.round(timeliness.onTimeRate * 100)}%
              </p>
              <p className="text-[11px] text-slate-400">
                of {timeliness.evaluatedCount} task{timeliness.evaluatedCount === 1 ? '' : 's'}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Avg variance</p>
              <p
                className={`text-2xl font-semibold tabular-nums ${
                  timeliness.avgVarianceDays > 0
                    ? 'text-danger'
                    : timeliness.avgVarianceDays < 0
                      ? 'text-success'
                      : 'text-text'
                }`}
              >
                {timeliness.avgVarianceDays > 0 ? '+' : ''}
                {timeliness.avgVarianceDays.toFixed(1)}d
              </p>
              <p className="text-[11px] text-slate-400">
                {timeliness.avgVarianceDays > 0
                  ? 'late on average'
                  : timeliness.avgVarianceDays < 0
                    ? 'early on average'
                    : 'right on plan'}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Behind plan</p>
              <p
                className={`text-2xl font-semibold tabular-nums ${
                  timeliness.behindPlanCount > 0 ? 'text-danger' : 'text-text'
                }`}
              >
                {timeliness.behindPlanCount}
              </p>
              <p className="text-[11px] text-slate-400">open, past planned date</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Window</p>
              <p className="text-2xl font-semibold tabular-nums text-text">
                {timeliness.windowDays}d
              </p>
              <p className="text-[11px] text-slate-400">trailing</p>
            </div>
          </div>
        )}
      </section>

      {/* Workload — open tasks per assignee with per-status breakdown. */}
      <section className="bg-white rounded shadow p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">Workload</h2>
          {singleTeam && (
            <button
              type="button"
              onClick={() => downloadReportCsv(singleTeam.id, 'workload', 'workload')}
              className="text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
              title="Download as CSV"
            >
              Export CSV
            </button>
          )}
        </div>
        {!workload && <p className="text-sm text-slate-500">Loading…</p>}
        {workload && workload.items.length === 0 && (
          <p className="text-sm text-slate-500 italic">Nothing open right now.</p>
        )}
        {workload && workload.items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-start text-xs text-slate-500 uppercase">
              <tr>
                <th className="py-1 pe-4">Assignee</th>
                <th className="py-1 pe-4 text-end">To do</th>
                <th className="py-1 pe-4 text-end">In progress</th>
                <th className="py-1 pe-4 text-end">Review</th>
                <th className="py-1 text-end">Total</th>
              </tr>
            </thead>
            <tbody>
              {workload.items.map((w) => (
                <tr key={w.assigneeId ?? 'unassigned'} className="border-t">
                  <td className="py-2 pe-4">
                    {w.assigneeName ?? <span className="italic text-slate-500">unassigned</span>}
                  </td>
                  <td className="py-2 pe-4 text-end tabular-nums text-slate-600">
                    {w.byStatus.TODO}
                  </td>
                  <td className="py-2 pe-4 text-end tabular-nums text-slate-600">
                    {w.byStatus.IN_PROGRESS}
                  </td>
                  <td className="py-2 pe-4 text-end tabular-nums text-slate-600">
                    {w.byStatus.REVIEW}
                  </td>
                  <td className="py-2 text-end tabular-nums font-medium">{w.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Budget — planned budget per project + per-currency rollup. */}
      <section className="bg-white rounded shadow p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">{t('reports.budget.title')}</h2>
          {singleTeam && (
            <button
              type="button"
              onClick={() => downloadReportCsv(singleTeam.id, 'budget', 'budget')}
              className="text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
              title="Download as CSV"
            >
              Export CSV
            </button>
          )}
        </div>
        {!budget && <p className="text-sm text-slate-500">Loading…</p>}
        {budget && budget.projects.length === 0 && (
          <p className="text-sm text-slate-500 italic">No projects in this team yet.</p>
        )}
        {budget && budget.projects.length > 0 && (
          <>
            <div className="overflow-x-auto mb-6">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="text-start text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="py-1 pe-4">{t('reports.budget.projects')}</th>
                    <th className="py-1 pe-4">{t('reports.budget.currency')}</th>
                    <th className="py-1 text-end">{t('reports.budget.planned')}</th>
                  </tr>
                </thead>
                <tbody>
                  {budget.projects.map((row) => (
                    <tr key={row.projectId} className="border-t">
                      <td className="py-2 pe-4 font-medium">{row.projectName}</td>
                      <td className="py-2 pe-4">{row.currency}</td>
                      <td className="py-2 text-end tabular-nums" dir="ltr">
                        {row.hasBudget ? (
                          fmtMoney(row.plannedBudget, row.currency)
                        ) : (
                          <span className="text-slate-400 italic">{t('reports.budget.noBudget')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {budget.rollupByCurrency.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-2 text-slate-600">
                  {t('reports.budget.rollup')}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {budget.rollupByCurrency.map((roll) => (
                    <div key={roll.currency} className="border rounded p-3 text-sm">
                      <p className="font-medium mb-2">{roll.currency}</p>
                      <dl className="space-y-1 text-xs">
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-500">{t('reports.budget.projects')}</dt>
                          <dd className="tabular-nums">{roll.projectCount}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-slate-500">{t('reports.budget.planned')}</dt>
                          <dd className="tabular-nums" dir="ltr">
                            {fmtMoney(roll.totalPlanned, roll.currency)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Overdue — open tasks past their dueDate, oldest first. */}
      <section className="bg-white rounded shadow p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">Overdue</h2>
          <div className="flex items-center gap-3">
            {overdue && (
              <span className="text-sm text-slate-500">
                {overdue.items.length} task{overdue.items.length === 1 ? '' : 's'}
              </span>
            )}
            {singleTeam && (
              <button
                type="button"
                onClick={() => downloadReportCsv(singleTeam.id, 'overdue', 'overdue')}
                className="text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
                title="Download as CSV"
              >
                Export CSV
              </button>
            )}
          </div>
        </div>
        {!overdue && <p className="text-sm text-slate-500">Loading…</p>}
        {overdue && overdue.items.length === 0 && (
          <p className="text-sm text-success italic">Nothing overdue. 👌</p>
        )}
        {overdue && overdue.items.length > 0 && (
          <ul className="divide-y">
            {overdue.items.map((r) => (
              <li key={r.taskId} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => nav(`/projects/${r.projectId}/tasks/${r.taskId}`)}
                    className="text-start font-medium hover:underline truncate min-w-0 flex-1"
                  >
                    {r.taskTitle}
                  </button>
                  <span className="text-xs text-danger whitespace-nowrap">
                    {r.daysOverdue} day{r.daysOverdue === 1 ? '' : 's'} late
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  {r.projectName} · {r.status}
                  {r.assigneeName ? ` · ${r.assigneeName}` : ' · unassigned'}
                  {' · due '}
                  <span dir="rtl">{formatShamsiDate(r.dueDate)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
