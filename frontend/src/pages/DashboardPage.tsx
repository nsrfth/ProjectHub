import { Link } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';

export default function DashboardPage(): JSX.Element {
  const { user, signOut } = useAuth();
  const { teams, currentTeam, currentTeamId, setCurrentTeamId, loading } = useTeams();

  return (
    <div className="min-h-screen p-8 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex items-center gap-4">
          {user?.globalRole === 'ADMIN' && (
            <Link to="/admin" className="text-sm underline">
              Admin
            </Link>
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
          <p className="mt-6 text-sm">
            <Link to="/projects" className="underline">
              View projects in {currentTeam.name} →
            </Link>
          </p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Open a project to see its kanban board and tasks.
        </p>
      </div>
    </div>
  );
}
