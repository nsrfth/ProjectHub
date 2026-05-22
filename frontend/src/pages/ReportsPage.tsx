import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import { fetchDoneReport, type DoneTaskRow } from '@/features/reports/api';
import { formatShamsiDate } from '@/lib/shamsi';

const WINDOWS: { days: number; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

// "Tasks done" report. Pulls the team's recently-completed tasks from the API
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

      <section className="bg-white rounded shadow p-4 mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <h2 className="font-medium mr-3">Tasks done</h2>
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
                        {formatShamsiDate(r.doneAt)}
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
    </div>
  );
}
