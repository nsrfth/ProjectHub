import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import * as adminApi from '@/features/admin/api';
import AdminUsersPanel, { useInvalidateAdminUsers } from '@/features/admin/AdminUsersPanel';
import DepartmentTransferPanel from '@/features/admin/DepartmentTransferPanel';
import { formatShamsiTimestampDate } from '@/lib/shamsi';
import { PasswordPolicyHints, PasswordStrengthIndicator } from '@/features/security/PasswordStrength';
import { useT } from '@/lib/i18n';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function AdminPage(): JSX.Element {
  const { user } = useAuth();
  const t = useT();
  const qc = useQueryClient();
  const invalidateUsers = useInvalidateAdminUsers();

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

  function resetTeams(): void {
    setTeamsPages([]);
    setTeamsDone(false);
    setTeamsCursor(null);
    qc.invalidateQueries({ queryKey: ['admin', 'teams'] });
  }

  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<adminApi.GlobalRole>('MEMBER');
  const [newError, setNewError] = useState<string | null>(null);
  const [newCreated, setNewCreated] = useState<adminApi.CreateUserResult | null>(null);

  const createUserMut = useMutation({
    mutationFn: () =>
      adminApi.createUser({
        email: newEmail.trim(),
        name: newName.trim(),
        password: newPassword || undefined,
        globalRole: newRole,
      }),
    onSuccess: (result) => {
      setNewError(null);
      setNewCreated(result);
      setNewEmail('');
      setNewName('');
      setNewPassword('');
      setNewRole('MEMBER');
      invalidateUsers();
    },
    onError: (err) => setNewError(errorMessage(err, 'Could not create user')),
  });

  const deleteTeamMut = useMutation({
    mutationFn: (teamId: string) => adminApi.deleteTeam(teamId),
    onSuccess: () => {
      resetTeams();
      qc.invalidateQueries({ queryKey: ['teams', 'mine'] });
    },
    onError: (err) => {
      window.alert(errorMessage(err, 'Could not delete team'));
    },
  });

  void teamsPageData;

  // Non-admins are redirected. Placed AFTER all hooks so hook order stays
  // stable across renders (react-hooks/rules-of-hooks).
  if (user && user.globalRole !== 'ADMIN') {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Admin</h1>

      <section className="bg-surface rounded shadow p-4 mb-6">
        <h2 className="font-medium mb-3">New user</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setNewCreated(null);
            createUserMut.mutate();
          }}
          className="grid grid-cols-1 md:grid-cols-2 gap-2"
        >
          <input
            type="email"
            required
            placeholder={t('admin.placeholder.email')}
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="rounded border border-border bg-surface text-text px-2 py-1 text-sm"
          />
          <input
            type="text"
            required
            placeholder={t('admin.placeholder.fullName')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="rounded border border-border bg-surface text-text px-2 py-1 text-sm"
          />
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <input
                type="text"
                placeholder={t('admin.placeholder.password')}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded border border-border bg-surface text-text px-2 py-1 text-sm font-mono"
                autoComplete="new-password"
              />
              <PasswordStrengthIndicator password={newPassword} />
            </div>
            <button
              type="button"
              onClick={() => setNewPassword('')}
              title="Clear so the server generates one"
              className="text-xs rounded border border-border px-2 py-1 text-text"
            >
              Auto
            </button>
          </div>
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as adminApi.GlobalRole)}
            className="rounded border border-border bg-surface text-text px-2 py-1 text-sm"
          >
            <option value="MEMBER">MEMBER (default)</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          <div className="md:col-span-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={createUserMut.isPending || !newEmail.trim() || !newName.trim()}
              className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {createUserMut.isPending ? 'Creating…' : 'Create user'}
            </button>
            <div className="text-xs text-text-muted">
              <PasswordPolicyHints />
              <p className="mt-1">Leave blank and the server will generate one — shown ONCE below.</p>
            </div>
          </div>
        </form>
        {newError && <p className="text-xs text-danger mt-2" role="alert">{newError}</p>}
        {newCreated && (
          <div className="mt-3 rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 p-3 text-sm">
            <p className="font-medium text-success">
              User created — copy credentials now
            </p>
            <p className="mt-1">
              Email:{' '}
              <code className="bg-surface px-1 rounded">{newCreated.user.email}</code>
            </p>
            <p>
              Password:{' '}
              {newCreated.generatedPassword ? (
                <code className="bg-surface px-1 rounded select-all">
                  {newCreated.generatedPassword}
                </code>
              ) : (
                <span className="text-slate-500 italic">(the value you entered)</span>
              )}
            </p>
            <button type="button" onClick={() => setNewCreated(null)} className="text-xs underline mt-2">
              Dismiss
            </button>
          </div>
        )}
      </section>

      <AdminUsersPanel />

      <DepartmentTransferPanel />

      <section className="bg-surface rounded shadow p-4">
        <h2 className="font-medium mb-3">Teams</h2>
        {teamsLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {!teamsLoading && teams.length === 0 && (
          <p className="text-sm text-slate-500">No teams.</p>
        )}
        <table className="w-full text-sm">
          <thead className="text-start text-xs text-slate-500 uppercase">
            <tr>
              <th className="py-1 pe-4">Name</th>
              <th className="py-1 pe-4">Slug</th>
              <th className="py-1 pe-4">Members</th>
              <th className="py-1 pe-4">Projects</th>
              <th className="py-1 pe-4">Created</th>
              <th className="py-1">Action</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="py-2 pe-4">{t.name}</td>
                <td className="py-2 pe-4 font-mono text-xs text-slate-600">{t.slug}</td>
                <td className="py-2 pe-4 text-slate-500">{t.memberCount}</td>
                <td className="py-2 pe-4 text-slate-500">{t.projectCount}</td>
                <td className="py-2 pe-4 text-slate-500 text-xs" dir="rtl">
                  {formatShamsiTimestampDate(t.createdAt)}
                </td>
                <td className="py-2">
                  <button
                    type="button"
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
                    className="text-xs text-danger hover:underline disabled:opacity-40"
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
            type="button"
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
