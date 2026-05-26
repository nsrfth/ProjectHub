import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { fetchDoneReport, fetchSummary, fetchWorkload } from '@/features/reports/api';
import { useT } from '@/lib/i18n';
import StatusDonut from '@/features/dashboard/StatusDonut';
import CompletionTrend from '@/features/dashboard/CompletionTrend';
import WorkloadBar from '@/features/dashboard/WorkloadBar';

export default function DashboardPage(): JSX.Element {
  const { user } = useAuth();
  const { teams, currentTeam, currentTeamId, setCurrentTeamId, loading } = useTeams();
  const t = useT();

  // Cheap summary endpoint feeds the headline numbers + the status donut.
  // Disabled until a team is selected so the first render after sign-in
  // doesn't fire a 404.
  const { data: summary } = useQuery({
    queryKey: ['reports', 'summary', currentTeam?.id],
    queryFn: () => fetchSummary(currentTeam!.id),
    enabled: !!currentTeam,
  });

  // v1.25: dashboard charts. Both queries fan out in parallel with the
  // summary query above. ~staleTime: 60s so re-mounts don't refetch.
  const { data: done } = useQuery({
    queryKey: ['reports', 'done', currentTeam?.id, 30],
    queryFn: () => fetchDoneReport(currentTeam!.id, 30),
    enabled: !!currentTeam,
    staleTime: 60_000,
  });
  const { data: workload } = useQuery({
    queryKey: ['reports', 'workload', currentTeam?.id],
    queryFn: () => fetchWorkload(currentTeam!.id),
    enabled: !!currentTeam,
    staleTime: 60_000,
  });

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">{t('dashboard.title')}</h1>

      {/* v1.27: top row — Current team (left) and At a glance (right)
          side-by-side. Two-column grid on lg+; stacks on smaller
          viewports. Both cards stretch to the same height via
          `items-stretch`. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6 items-stretch">
        <div className="bg-white dark:bg-slate-800 rounded shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-medium">{t('dashboard.currentTeam')}</h2>
            <Link to="/teams" className="text-sm underline">
              {t('dashboard.manageTeams')}
            </Link>
          </div>

          {loading && <p className="text-sm text-slate-500 dark:text-slate-400">{t('dashboard.loadingTeams')}</p>}

          {!loading && teams.length === 0 && (
            <p className="text-sm text-slate-500">
              You're not in any team yet.{' '}
              <Link to="/teams" className="underline">
                Create one
              </Link>
              .
            </p>
          )}

          {!loading && teams.length > 0 && (
            <div className="flex items-center gap-3">
              <select
                value={currentTeamId ?? ''}
                onChange={(e) => setCurrentTeamId(e.target.value || null)}
                className="rounded border-slate-300 px-2 py-1 border text-sm"
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {currentTeam && (
                <span className="text-xs uppercase tracking-wide text-slate-500">
                  {currentTeam.myRole}
                </span>
              )}
            </div>
          )}

          {currentTeam && (
            <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Link to="/projects" className="underline">
                {t('dashboard.viewProjects').replace('{team}', currentTeam.name)}
              </Link>
              <Link to="/reports" className="underline text-slate-600 dark:text-slate-300">
                {t('nav.reports')}
              </Link>
              <Link to="/calendar" className="underline text-slate-600 dark:text-slate-300">
                {t('nav.calendar')}
              </Link>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Open a project to see its kanban board and tasks.
          </p>
        </div>

        {/* At a glance — placeholder card when no team is selected yet
            so the grid stays two-up + the user knows something will
            appear here once they pick a team. */}
        <div className="bg-white dark:bg-slate-800 rounded shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-medium">At a glance</h2>
            {currentTeam && summary && (
              <Link to="/reports" className="text-sm underline">
                Full reports →
              </Link>
            )}
          </div>
          {currentTeam && summary ? (
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-semibold tabular-nums">{summary.openCount}</p>
                <p className="text-xs text-slate-500 uppercase tracking-wide mt-1">Open</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums text-emerald-700">
                  {summary.doneLast7Days}
                </p>
                <p className="text-xs text-slate-500 uppercase tracking-wide mt-1">Done (7d)</p>
              </div>
              <div>
                <p
                  className={`text-2xl font-semibold tabular-nums ${
                    summary.overdueCount > 0 ? 'text-red-700' : 'text-slate-700'
                  }`}
                >
                  {summary.overdueCount}
                </p>
                <p className="text-xs text-slate-500 uppercase tracking-wide mt-1">Overdue</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500 italic">
              Select a team to see headline numbers.
            </p>
          )}
        </div>
      </div>

      {/* Charts grid — sits just below the top row. Three cards in a
          responsive grid (1 / 2 / 3 columns at sm / lg / xl). */}
      {currentTeam && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
          {summary && (
            <ChartCard title="Where work sits" subtitle="By status">
              <StatusDonut byStatus={summary.byStatus} />
            </ChartCard>
          )}
          {done && (
            <ChartCard title="Throughput" subtitle="Tasks completed">
              <CompletionTrend rows={done.items} days={30} />
            </ChartCard>
          )}
          {workload && (
            <ChartCard title="Workload" subtitle="Open tasks per person">
              <WorkloadBar rows={workload.items} />
            </ChartCard>
          )}
        </div>
      )}

      {/* Signed-in identity — least urgent info, lives at the bottom now
          that the user menu in the top-right also surfaces it. */}
      <div className="bg-white dark:bg-slate-800 rounded shadow px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-slate-500 dark:text-slate-400">
          {t('dashboard.signedInAs')}:
        </span>
        <span className="font-medium">{user?.name}</span>
        <span className="text-slate-500 dark:text-slate-400">{user?.email}</span>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-2 py-0.5">
          {user?.globalRole}
        </span>
      </div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="bg-white dark:bg-slate-800 rounded shadow p-5">
      <div className="mb-3">
        <h3 className="font-medium text-sm text-slate-900 dark:text-slate-100">{title}</h3>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 uppercase tracking-wide">
          {subtitle}
        </p>
      </div>
      {children}
    </section>
  );
}
