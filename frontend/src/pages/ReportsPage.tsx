import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import {
  downloadReportCsv,
  fetchDoneReport,
  fetchOverdue,
  fetchSummary,
  fetchTimeliness,
  fetchWorkload,
  type DoneTaskRow,
} from '@/features/reports/api';
import { formatShamsiDate } from '@/lib/shamsi';

const WINDOWS: { days: number; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

// "Tasks completed" report. Pulls the team's recently-completed tasks from the API
// and presents them two ways: a flat list (most recent first) and a per-
// assignee tally. Both pivots come from one query — server returns a flat
// row set, the UI groups in memory.
export default function ReportsPage(): JSX.Element {
  const { currentTeam } = useTeams();
  const nav = useNavigate();
  const [days, setDays] = useState<number>(7);

  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'done', currentTeam?.id, days],
    queryFn: () => fetchDoneReport(currentTeam!.id, days),
    enabled: !!currentTeam,
  });

  const { data: summary } = useQuery({
    queryKey: ['reports', 'summary', currentTeam?.id],
    queryFn: () => fetchSummary(currentTeam!.id),
    enabled: !!currentTeam,
  });

  const { data: workload } = useQuery({
    queryKey: ['reports', 'workload', currentTeam?.id],
    queryFn: () => fetchWorkload(currentTeam!.id),
    enabled: !!currentTeam,
  });

  const { data: overdue } = useQuery({
    queryKey: ['reports', 'overdue', currentTeam?.id],
    queryFn: () => fetchOverdue(currentTeam!.id),
    enabled: !!currentTeam,
  });

  const { data: timeliness } = useQuery({
    queryKey: ['reports', 'timeliness', currentTeam?.id, days],
    queryFn: () => fetchTimeliness(currentTeam!.id, days),
    enabled: !!currentTeam,
  });

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

  return (
    <div className="min-h-screen p-8 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-sm text-slate-500">
            in <span className="font-medium">{currentTeam.name}</span>
          </p>
        </div>
        <Link to="/dashboard" className="text-sm underline">
          Back to dashboard
        </Link>
      </header>

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
            <p className="text-2xl font-semibold tabular-nums text-emerald-700">
              {summary.doneLast7Days}
            </p>
          </div>
          <div className="bg-white rounded shadow p-3">
            <p className="text-xs text-slate-500 uppercase tracking-wide">Overdue</p>
            <p
              className={`text-2xl font-semibold tabular-nums ${
                summary.overdueCount > 0 ? 'text-red-700' : 'text-slate-700'
              }`}
            >
              {summary.overdueCount}
            </p>
          </div>
        </section>
      )}

      <section className="bg-white rounded shadow p-4 mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <h2 className="font-medium mr-3">Tasks completed</h2>
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setDays(w.days)}
              className={`text-xs rounded px-2 py-1 border ${
                w.days === days ? 'bg-slate-900 text-white' : 'border-slate-300'
              }`}
            >
              {w.label}
            </button>
          ))}
          {data && (
            <span className="ml-auto text-sm text-slate-500">
              {data.items.length} task{data.items.length === 1 ? '' : 's'}
            </span>
          )}
          <button
            type="button"
            onClick={() => downloadReportCsv(currentTeam.id, 'done', `tasks-done-${days}d`, { days })}
            className="text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
            title="Download as CSV"
          >
            Export CSV
          </button>
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
                        className="text-left font-medium hover:underline truncate min-w-0 flex-1"
                      >
                        {r.taskTitle}
                      </button>
                      <span className="text-xs text-slate-500" dir="rtl">
                        {formatShamsiDate(r.completedAt)}
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
          <h2 className="font-medium mr-3">Timeliness</h2>
          <span className="text-xs text-slate-500">
            (same window as "Tasks completed")
          </span>
          <button
            type="button"
            onClick={() =>
              downloadReportCsv(currentTeam.id, 'timeliness', `timeliness-${days}d`, { days })
            }
            className="ml-auto text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
            title="Download as CSV"
          >
            Export CSV
          </button>
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
                    ? 'text-emerald-700'
                    : timeliness.onTimeRate >= 0.5
                      ? 'text-amber-700'
                      : 'text-red-700'
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
                    ? 'text-red-700'
                    : timeliness.avgVarianceDays < 0
                      ? 'text-emerald-700'
                      : 'text-slate-700'
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
                  timeliness.behindPlanCount > 0 ? 'text-red-700' : 'text-slate-700'
                }`}
              >
                {timeliness.behindPlanCount}
              </p>
              <p className="text-[11px] text-slate-400">open, past planned date</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Window</p>
              <p className="text-2xl font-semibold tabular-nums text-slate-700">
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
          <button
            type="button"
            onClick={() => downloadReportCsv(currentTeam.id, 'workload', 'workload')}
            className="text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
            title="Download as CSV"
          >
            Export CSV
          </button>
        </div>
        {!workload && <p className="text-sm text-slate-500">Loading…</p>}
        {workload && workload.items.length === 0 && (
          <p className="text-sm text-slate-500 italic">Nothing open right now.</p>
        )}
        {workload && workload.items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500 uppercase">
              <tr>
                <th className="py-1 pr-4">Assignee</th>
                <th className="py-1 pr-4 text-right">To do</th>
                <th className="py-1 pr-4 text-right">In progress</th>
                <th className="py-1 pr-4 text-right">Review</th>
                <th className="py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {workload.items.map((w) => (
                <tr key={w.assigneeId ?? 'unassigned'} className="border-t">
                  <td className="py-2 pr-4">
                    {w.assigneeName ?? <span className="italic text-slate-500">unassigned</span>}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-slate-600">
                    {w.byStatus.TODO}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-slate-600">
                    {w.byStatus.IN_PROGRESS}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-slate-600">
                    {w.byStatus.REVIEW}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium">{w.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
            <button
              type="button"
              onClick={() => downloadReportCsv(currentTeam.id, 'overdue', 'overdue')}
              className="text-xs rounded px-2 py-1 border border-slate-300 hover:bg-slate-100"
              title="Download as CSV"
            >
              Export CSV
            </button>
          </div>
        </div>
        {!overdue && <p className="text-sm text-slate-500">Loading…</p>}
        {overdue && overdue.items.length === 0 && (
          <p className="text-sm text-emerald-700 italic">Nothing overdue. 👌</p>
        )}
        {overdue && overdue.items.length > 0 && (
          <ul className="divide-y">
            {overdue.items.map((r) => (
              <li key={r.taskId} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => nav(`/projects/${r.projectId}/tasks/${r.taskId}`)}
                    className="text-left font-medium hover:underline truncate min-w-0 flex-1"
                  >
                    {r.taskTitle}
                  </button>
                  <span className="text-xs text-red-700 whitespace-nowrap">
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
