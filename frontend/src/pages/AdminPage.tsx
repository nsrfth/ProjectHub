import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import * as adminApi from '@/features/admin/api';
import { formatShamsiTimestampDate } from '@/lib/shamsi';

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

  // Cursor pagination. Pages accumulate in component state so "Load more"
  // appends rather than replacing — the typical admin pattern.
  const [usersCursor, setUsersCursor] = useState<string | null>(null);
  const [usersPages, setUsersPages] = useState<adminApi.AdminUser[]>([]);
  const [usersDone, setUsersDone] = useState(false);

  const { data: usersPage, isLoading: usersLoading } = useQuery({
    queryKey: ['admin', 'users', usersCursor],
    queryFn: () =>
      adminApi.listUsers({ cursor: usersCursor ?? undefined, limit: 25 }).then((p) => {
        setUsersPages((prev) =>
          usersCursor === null ? p.items : [...prev, ...p.items],
        );
        if (!p.nextCursor) setUsersDone(true);
        return p;
      }),
  });
  const users = usersPages;

  const [teamsCursor, setTeamsCursor] = useState<string | null>(null);
  const [teamsPages, setTeamsPages] = useState<adminApi.AdminTeam[]>([]);
  const [teamsDone, setTeamsDone] = useState(false);

  const { data: teamsPageData, isLoading: teamsLoading } = useQuery({
    queryKey: ['admin', 'teams', teamsCursor],
    queryFn: () =>
      adminApi.listTeams({ cursor: teamsCursor ?? undefined, limit: 25 }).then((p) => {
        setTeamsPages((prev) =>
          teamsCursor === null ? p.items : [...prev, ...p.items],
        );
        if (!p.nextCursor) setTeamsDone(true);
        return p;
      }),
  });
  const teams = teamsPages;

  // After a mutation, the simplest correctness model is: wipe the accumulated
  // page state and re-fetch from cursor=null. Avoids subtle "stale row in the
  // middle of page 2" bugs.
  function resetUsers(): void {
    setUsersPages([]);
    setUsersDone(false);
    setUsersCursor(null);
    qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  }
  function resetTeams(): void {
    setTeamsPages([]);
    setTeamsDone(false);
    setTeamsCursor(null);
    qc.invalidateQueries({ queryKey: ['admin', 'teams'] });
  }

  const updateRoleMut = useMutation({
    mutationFn: (input: { userId: string; role: adminApi.GlobalRole }) =>
      adminApi.updateUserRole(input.userId, input.role),
    onSuccess: () => resetUsers(),
    onError: (err) => {
      window.alert(errorMessage(err, 'Could not update role'));
    },
  });

  const deleteUserMut = useMutation({
    mutationFn: (userId: string) => adminApi.deleteUser(userId),
    onSuccess: () => resetUsers(),
    onError: (err) => {
      window.alert(errorMessage(err, 'Could not delete user'));
    },
  });

  const deleteTeamMut = useMutation({
    mutationFn: (teamId: string) => adminApi.deleteTeam(teamId),
    onSuccess: () => {
      resetTeams();
      qc.invalidateQueries({ queryKey: ['teams', 'mine'] }); // dashboard picker
    },
    onError: (err) => {
      window.alert(errorMessage(err, 'Could not delete team'));
    },
  });

  // Avoid unused-var lint warnings — these are read implicitly by the query.
  void usersPage;
  void teamsPageData;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Admin</h1>

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
              <th className="py-1 pr-4">Joined</th>
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
                  <td className="py-2 pr-4 text-slate-500 text-xs" dir="rtl">
                    {formatShamsiTimestampDate(u.createdAt)}
                  </td>
                  <td className="py-2">
                    <button
                      disabled={isSelf || updateRoleMut.isPending}
                      onClick={() => {
                        if (window.confirm(`Change ${u.email} → ${otherRole}?`)) {
                          updateRoleMut.mutate({ userId: u.id, role: otherRole });
                        }
                      }}
                      className="text-xs underline disabled:opacity-40 mr-3"
                      title={isSelf ? 'You cannot change your own role' : undefined}
                    >
                      {u.globalRole === 'ADMIN' ? 'Demote' : 'Promote'}
                    </button>
                    <button
                      disabled={isSelf || deleteUserMut.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete ${u.email}? Their projects/tasks/comments survive with "(deleted user)" attribution. Activity log + attachments are removed.`,
                          )
                        ) {
                          deleteUserMut.mutate(u.id);
                        }
                      }}
                      className="text-xs text-red-600 hover:underline disabled:opacity-40"
                      title={isSelf ? 'You cannot delete your own account' : undefined}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!usersDone && users.length > 0 && (
          <button
            onClick={() => setUsersCursor(users[users.length - 1].id)}
            disabled={usersLoading}
            className="mt-3 text-xs underline disabled:opacity-50"
          >
            {usersLoading ? 'Loading…' : 'Load more'}
          </button>
        )}
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
              <th className="py-1 pr-4">Created</th>
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
                <td className="py-2 pr-4 text-slate-500 text-xs" dir="rtl">
                  {formatShamsiTimestampDate(t.createdAt)}
                </td>
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
        {!teamsDone && teams.length > 0 && (
          <button
            onClick={() => setTeamsCursor(teams[teams.length - 1].id)}
            disabled={teamsLoading}
            className="mt-3 text-xs underline disabled:opacity-50"
          >
            {teamsLoading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>
    </div>
  );
}
