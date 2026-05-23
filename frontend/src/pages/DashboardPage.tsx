import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { fetchSummary } from '@/features/reports/api';

export default function DashboardPage(): JSX.Element {
  const { user, signOut } = useAuth();
  const { teams, currentTeam, currentTeamId, setCurrentTeamId, loading } = useTeams();

  // Cheap summary endpoint feeds the dashboard widget. Disabled until a team
  // is selected so the first render after sign-in doesn't fire a 404.
  const { data: summary } = useQuery({
    queryKey: ['reports', 'summary', currentTeam?.id],
    queryFn: () => fetchSummary(currentTeam!.id),
    enabled: !!currentTeam,
  });

  return (
    <div className="min-h-screen p-8 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex items-center gap-4">
          {user?.globalRole === 'ADMIN' && (
            <>
              <Link to="/admin" className="text-sm underline">
                Admin
              </Link>
              <Link to="/settings" className="text-sm underline">
                Settings
              </Link>
            </>
          )}
          <button onClick={() => signOut()} className="text-sm underline">
            Sign out
          </button>
        </div>
      </header>

      <div className="bg-white rounded shadow p-6 mb-6">
        <p className="text-sm text-slate-600">Signed in as</p>
        <p className="font-medium">{user?.name}</p>
        <p className="text-sm text-slate-500">{user?.email}</p>
        <p className="text-xs text-slate-400 mt-2">Role: {user?.globalRole}</p>
      </div>

      <div className="bg-white rounded shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-medium">Current team</h2>
          <Link to="/teams" className="text-sm underline">
            Manage teams
          </Link>
        </div>

        {loading && <p className="text-sm text-slate-500">Loading teams…</p>}

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
              View projects in {currentTeam.name} →
            </Link>
            <Link to="/reports" className="underline text-slate-600">
              Reports
            </Link>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Open a project to see its kanban board and tasks.
        </p>
      </div>

      {/* Summary widget — three headline numbers when a team is active. */}
      {currentTeam && summary && (
        <div className="bg-white rounded shadow p-6 mt-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-medium">At a glance</h2>
            <Link to="/reports" className="text-sm underline">
              Full reports →
            </Link>
          </div>
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
        </div>
      )}
    </div>
  );
}
