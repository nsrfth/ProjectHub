import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import * as adminApi from '@/features/admin/api';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function AdminPage(): JSX.Element {
  const { user } = useAuth();
  const qc = useQueryClient();

  // Belt-and-braces: backend already gates with requireGlobalRole, but
  // bouncing non-admins client-side gives a faster UX than waiting for a 403.
  if (user && user.globalRole !== 'ADMIN') {
    return <Navigate to="/dashboard" replace />;
  }

  const { data: users = [], isLoading: usersLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: adminApi.listUsers,
  });

  const { data: teams = [], isLoading: teamsLoading } = useQuery({
    queryKey: ['admin', 'teams'],
    queryFn: adminApi.listTeams,
  });

  const updateRoleMut = useMutation({
    mutationFn: (input: { userId: string; role: adminApi.GlobalRole }) =>
      adminApi.updateUserRole(input.userId, input.role),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err) => {
      window.alert(errorMessage(err, 'Could not update role'));
    },
  });

  const deleteTeamMut = useMutation({
    mutationFn: (teamId: string) => adminApi.deleteTeam(teamId),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['admin', 'teams'] }),
        qc.invalidateQueries({ queryKey: ['teams', 'mine'] }), // dashboard picker too
      ]);
    },
    onError: (err) => {
      window.alert(errorMessage(err, 'Could not delete team'));
    },
  });

  return (
    <div className="min-h-screen p-8 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <Link to="/dashboard" className="text-sm underline">
          Back to dashboard
        </Link>
      </header>

      <section className="bg-white rounded shadow p-4 mb-6">
        <h2 className="font-medium mb-3">Users</h2>
        {usersLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {!usersLoading && users.length === 0 && (
          <p className="text-sm text-slate-500">No users.</p>
        )}
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500 uppercase">
            <tr>
              <th className="py-1 pr-4">Name</th>
              <th className="py-1 pr-4">Email</th>
              <th className="py-1 pr-4">Role</th>
              <th className="py-1 pr-4">Teams</th>
              <th className="py-1">Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === user?.id;
              const otherRole: adminApi.GlobalRole = u.globalRole === 'ADMIN' ? 'MEMBER' : 'ADMIN';
              return (
                <tr key={u.id} className="border-t">
                  <td className="py-2 pr-4">{u.name}</td>
                  <td className="py-2 pr-4 text-slate-600">{u.email}</td>
                  <td className="py-2 pr-4">
                    <span className="text-xs uppercase tracking-wide text-slate-500">
                      {u.globalRole}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-slate-500">{u.membershipCount}</td>
                  <td className="py-2">
                    <button
                      disabled={isSelf || updateRoleMut.isPending}
                      onClick={() => {
                        if (window.confirm(`Change ${u.email} → ${otherRole}?`)) {
                          updateRoleMut.mutate({ userId: u.id, role: otherRole });
                        }
                      }}
                      className="text-xs underline disabled:opacity-40"
                      title={isSelf ? 'You cannot change your own role' : undefined}
                    >
                      {u.globalRole === 'ADMIN' ? 'Demote' : 'Promote'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="bg-white rounded shadow p-4">
        <h2 className="font-medium mb-3">Teams</h2>
        {teamsLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {!teamsLoading && teams.length === 0 && (
          <p className="text-sm text-slate-500">No teams.</p>
        )}
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500 uppercase">
            <tr>
              <th className="py-1 pr-4">Name</th>
              <th className="py-1 pr-4">Slug</th>
              <th className="py-1 pr-4">Members</th>
              <th className="py-1 pr-4">Projects</th>
              <th className="py-1">Action</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="py-2 pr-4">{t.name}</td>
                <td className="py-2 pr-4 font-mono text-xs text-slate-600">{t.slug}</td>
                <td className="py-2 pr-4 text-slate-500">{t.memberCount}</td>
                <td className="py-2 pr-4 text-slate-500">{t.projectCount}</td>
                <td className="py-2">
                  <button
                    disabled={deleteTeamMut.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete team "${t.name}" and all its projects/tasks? This cannot be undone.`,
                        )
                      ) {
                        deleteTeamMut.mutate(t.id);
                      }
                    }}
                    className="text-xs text-red-600 hover:underline disabled:opacity-40"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
