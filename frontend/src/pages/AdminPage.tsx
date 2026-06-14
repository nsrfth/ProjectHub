import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import * as adminApi from '@/features/admin/api';
import { formatShamsiTimestampDate } from '@/lib/shamsi';
import { PasswordPolicyHints, PasswordStrengthIndicator } from '@/features/security/PasswordStrength';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

function authSourceLabel(source: adminApi.AuthSource): string {
  switch (source) {
    case 'LDAP': return 'LDAP';
    case 'SCIM': return 'SCIM';
    default: return 'Local';
  }
}

function authSourceBadgeClass(source: adminApi.AuthSource): string {
  switch (source) {
    case 'LDAP': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200';
    case 'SCIM': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200';
    default: return 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200';
  }
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
  const [roleUpdatingId, setRoleUpdatingId] = useState<string | null>(null);

  function changeUserRole(u: adminApi.AdminUser, role: adminApi.GlobalRole): void {
    if (role === u.globalRole) return;
    if (!window.confirm(`Change ${u.email} to ${role}?`)) return;
    setRoleUpdatingId(u.id);
    updateRoleMut.mutate(
      { userId: u.id, role },
      { onSettled: () => setRoleUpdatingId(null) },
    );
  }

  const deleteUserMut = useMutation({
    mutationFn: (userId: string) => adminApi.deleteUser(userId),
    onSuccess: () => resetUsers(),
    onError: (err) => {
      window.alert(errorMessage(err, 'Could not delete user'));
    },
  });

  const [ldapPanelUserId, setLdapPanelUserId] = useState<string | null>(null);
  const [ldapTestPassword, setLdapTestPassword] = useState('');
  const [ldapActionMsg, setLdapActionMsg] = useState<string | null>(null);
  const [ldapActionErr, setLdapActionErr] = useState<string | null>(null);

  const refreshLdapMut = useMutation({
    mutationFn: (userId: string) => adminApi.refreshLdapUser(userId),
    onSuccess: () => {
      setLdapActionMsg('User information refreshed from directory.');
      setLdapActionErr(null);
      resetUsers();
    },
    onError: (err) => setLdapActionErr(errorMessage(err, 'Could not refresh user')),
  });

  const testLdapMut = useMutation({
    mutationFn: (input: { userId: string; password: string }) =>
      adminApi.testLdapUserAuth(input.userId, input.password),
    onSuccess: () => {
      setLdapActionMsg('Directory credentials are valid.');
      setLdapActionErr(null);
      setLdapTestPassword('');
    },
    onError: (err) => setLdapActionErr(errorMessage(err, 'Directory authentication failed')),
  });

  // v1.32.0: reset-password modal state. Lives on the page so the one-time
  // generated password reveals inline below the form, mirroring the
  // createUser pattern above.
  const [resetTarget, setResetTarget] = useState<adminApi.AdminUser | null>(null);
  const [resetCustom, setResetCustom] = useState('');
  const [resetResult, setResetResult] = useState<adminApi.ResetPasswordResult | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const resetPasswordMut = useMutation({
    mutationFn: () =>
      adminApi.resetUserPassword(resetTarget!.id, resetCustom || undefined),
    onSuccess: (r) => {
      setResetResult(r);
      setResetError(null);
      setResetCustom('');
    },
    onError: (err) => setResetError(errorMessage(err, 'Could not reset password')),
  });

  function openReset(u: adminApi.AdminUser): void {
    setResetTarget(u);
    setResetResult(null);
    setResetError(null);
    setResetCustom('');
  }
  function closeReset(): void {
    setResetTarget(null);
    setResetResult(null);
    setResetError(null);
    setResetCustom('');
  }

  // v1.26: admin-provisioned new user. Form state lives here so we can
  // surface the one-time generated password without a modal — show it
  // inline after a successful create, then dismiss on the next action.
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
        // Empty string -> omit -> server generates a password.
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
      resetUsers();
    },
    onError: (err) => setNewError(errorMessage(err, 'Could not create user')),
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
    <div className="max-w-5xl">
      <h1 className="text-2xl font-semibold mb-6">Admin</h1>

      {/* v1.26: admin-provisioned user. Email + name + password (or auto-
          generate). The one-time-only generated password is shown inline
          after the mutation succeeds so it can be copied. */}
      <section className="bg-white dark:bg-slate-800 rounded shadow p-4 mb-6">
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
            placeholder="user@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm"
          />
          <input
            type="text"
            required
            placeholder="Full name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm"
          />
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <input
                type="text"
                placeholder="Password (leave blank to auto-generate)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm font-mono"
                autoComplete="new-password"
              />
              <PasswordStrengthIndicator password={newPassword} />
            </div>
            <button
              type="button"
              onClick={() => setNewPassword('')}
              title="Clear so the server generates one"
              className="text-xs rounded border border-slate-300 dark:border-slate-600 px-2 py-1 text-slate-600 dark:text-slate-300"
            >
              Auto
            </button>
          </div>
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as adminApi.GlobalRole)}
            className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm"
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
            <div className="text-xs text-slate-500 dark:text-slate-400">
              <PasswordPolicyHints />
              <p className="mt-1">Leave blank and the server will generate one — shown ONCE below.</p>
            </div>
          </div>
        </form>
        {newError && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{newError}</p>}
        {newCreated && (
          <div className="mt-3 rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 p-3 text-sm">
            <p className="font-medium text-emerald-900 dark:text-emerald-200">
              User created — copy credentials now
            </p>
            <p className="mt-1">
              Email:{' '}
              <code className="bg-white dark:bg-slate-800 px-1 rounded">
                {newCreated.user.email}
              </code>
            </p>
            <p>
              Password:{' '}
              {newCreated.generatedPassword ? (
                <code className="bg-white dark:bg-slate-800 px-1 rounded select-all">
                  {newCreated.generatedPassword}
                </code>
              ) : (
                <span className="text-slate-500 italic">
                  (the value you entered)
                </span>
              )}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
              This is the only time the password is displayed. Hand it over via
              a secure channel; have the user change it after first sign-in.
            </p>
            <button
              type="button"
              onClick={() => setNewCreated(null)}
              className="text-xs underline mt-2"
            >
              Dismiss
            </button>
          </div>
        )}
      </section>

      <section className="bg-white dark:bg-slate-800 rounded shadow p-4 mb-6">
        <h2 className="font-medium mb-3">Users</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Change a user&apos;s instance role with the dropdown in the Role column.
          Admin can access Settings and manage users; Member is the default for everyone else.
        </p>
        {usersLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {!usersLoading && users.length === 0 && (
          <p className="text-sm text-slate-500">No users.</p>
        )}
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500 uppercase">
            <tr>
              <th className="py-1 pr-4">Name</th>
              <th className="py-1 pr-4">Email</th>
              <th className="py-1 pr-4">Auth</th>
              <th className="py-1 pr-4">LDAP user</th>
              <th className="py-1 pr-4">Role</th>
              <th className="py-1 pr-4">Teams</th>
              <th className="py-1 pr-4">Joined</th>
              <th className="py-1">Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === user?.id;
              const roleBusy = roleUpdatingId === u.id && updateRoleMut.isPending;
              return (
                <tr key={u.id} className="border-t dark:border-slate-700">
                  <td className="py-2 pr-4">{u.name}</td>
                  <td className="py-2 pr-4 text-slate-600 dark:text-slate-300">{u.email}</td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${authSourceBadgeClass(u.authSource)}`}>
                      {authSourceLabel(u.authSource)}
                    </span>
                    {u.authSource === 'LDAP' && (
                      <p className="text-[10px] text-slate-500 mt-0.5">
                        {u.directoryActive ? u.directoryName ?? 'Linked' : 'Directory offline'}
                      </p>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-slate-500 font-mono text-xs">
                    {u.ldapUsername ?? '—'}
                  </td>
                  <td className="py-2 pr-4">
                    {isSelf ? (
                      <span
                        className="text-xs uppercase tracking-wide text-slate-500"
                        title="You cannot change your own role — ask another admin"
                      >
                        {u.globalRole}
                      </span>
                    ) : (
                      <select
                        value={u.globalRole}
                        disabled={roleBusy}
                        onChange={(e) =>
                          changeUserRole(u, e.target.value as adminApi.GlobalRole)
                        }
                        aria-label={`Role for ${u.email}`}
                        className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-xs uppercase tracking-wide disabled:opacity-50"
                      >
                        <option value="MEMBER">Member</option>
                        <option value="ADMIN">Admin</option>
                      </select>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-slate-500">{u.membershipCount}</td>
                  <td className="py-2 pr-4 text-slate-500 text-xs" dir="rtl">
                    {formatShamsiTimestampDate(u.createdAt)}
                  </td>
                  <td className="py-2">
                    <button
                      disabled={u.authSource !== 'LOCAL'}
                      onClick={() => openReset(u)}
                      className="text-xs underline disabled:opacity-40 mr-3"
                      title={u.authSource !== 'LOCAL' ? 'Directory-owned' : undefined}
                    >
                      Reset password
                    </button>
                    {u.authSource === 'LDAP' && (
                      <button
                        type="button"
                        onClick={() => {
                          setLdapPanelUserId(ldapPanelUserId === u.id ? null : u.id);
                          setLdapActionMsg(null);
                          setLdapActionErr(null);
                          setLdapTestPassword('');
                        }}
                        className="text-xs underline mr-3"
                      >
                        {ldapPanelUserId === u.id ? 'Hide LDAP' : 'LDAP'}
                      </button>
                    )}
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

        {ldapPanelUserId && (() => {
          const u = users.find((row) => row.id === ldapPanelUserId);
          if (!u || u.authSource !== 'LDAP') return null;
          return (
            <div className="mt-4 rounded border border-blue-200 dark:border-blue-800 p-3 text-sm bg-blue-50/50 dark:bg-blue-900/10">
              <p className="font-medium mb-2">LDAP — {u.email}</p>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
                <div><dt className="text-slate-500 inline">Directory: </dt><dd className="inline">{u.directoryName ?? '—'}</dd></div>
                <div><dt className="text-slate-500 inline">Status: </dt><dd className="inline">{u.directoryActive ? 'Connected' : 'Not configured'}</dd></div>
                <div><dt className="text-slate-500 inline">Username: </dt><dd className="inline font-mono">{u.ldapUsername ?? '—'}</dd></div>
                <div><dt className="text-slate-500 inline">UPN: </dt><dd className="inline font-mono">{u.userPrincipalName ?? '—'}</dd></div>
                <div><dt className="text-slate-500 inline">Department: </dt><dd className="inline">{u.department ?? '—'}</dd></div>
                <div><dt className="text-slate-500 inline">Job title: </dt><dd className="inline">{u.jobTitle ?? '—'}</dd></div>
                <div><dt className="text-slate-500 inline">Manager: </dt><dd className="inline">{u.managerName ?? '—'}</dd></div>
                <div><dt className="text-slate-500 inline">Last sync: </dt><dd className="inline">{u.ldapSyncedAt ? formatShamsiTimestampDate(u.ldapSyncedAt) : 'Never'}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-2 items-center mb-2">
                <button
                  type="button"
                  disabled={refreshLdapMut.isPending}
                  onClick={() => refreshLdapMut.mutate(u.id)}
                  className="text-xs rounded border border-slate-300 dark:border-slate-600 px-2 py-1"
                >
                  {refreshLdapMut.isPending ? 'Refreshing…' : 'Refresh from directory'}
                </button>
              </div>
              <form
                className="flex flex-wrap gap-2 items-center"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!ldapTestPassword) return;
                  testLdapMut.mutate({ userId: u.id, password: ldapTestPassword });
                }}
              >
                <input
                  type="password"
                  value={ldapTestPassword}
                  onChange={(e) => setLdapTestPassword(e.target.value)}
                  placeholder="Test directory password"
                  autoComplete="new-password"
                  className="flex-1 min-w-[12rem] rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 px-2 py-1 text-xs font-mono"
                />
                <button
                  type="submit"
                  disabled={testLdapMut.isPending || !ldapTestPassword}
                  className="text-xs rounded bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900 px-2 py-1 disabled:opacity-50"
                >
                  {testLdapMut.isPending ? 'Testing…' : 'Test authentication'}
                </button>
              </form>
              {ldapActionMsg && <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-2">{ldapActionMsg}</p>}
              {ldapActionErr && <p className="text-xs text-red-600 mt-2">{ldapActionErr}</p>}
            </div>
          );
        })()}

        {/* v1.32.0: reset-password panel. Reveals the generated password
            once when the admin lets the server pick. */}
        {resetTarget && (
          <div className="mt-4 rounded border border-slate-300 dark:border-slate-600 p-3 text-sm bg-slate-50 dark:bg-slate-800/40">
            <p className="font-medium mb-2">Reset password for {resetTarget.email}</p>
            {resetResult ? (
              <div className="space-y-2">
                {resetResult.generatedPassword ? (
                  <>
                    <p className="text-xs">New password — copy now (shown once):</p>
                    <code className="block bg-white dark:bg-slate-900 px-2 py-1 rounded select-all font-mono">
                      {resetResult.generatedPassword}
                    </code>
                  </>
                ) : (
                  <p className="text-emerald-700 dark:text-emerald-400">
                    Password updated.
                  </p>
                )}
                <button
                  type="button"
                  onClick={closeReset}
                  className="text-xs underline mt-1"
                >
                  Done
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  resetPasswordMut.mutate();
                }}
                className="flex flex-wrap gap-2 items-center"
              >
                <input
                  type="text"
                  value={resetCustom}
                  onChange={(e) => setResetCustom(e.target.value)}
                  placeholder="Leave blank to auto-generate"
                  autoComplete="new-password"
                  className="flex-1 min-w-[16rem] rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm font-mono"
                />
                <button
                  type="submit"
                  disabled={resetPasswordMut.isPending}
                  className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
                >
                  {resetPasswordMut.isPending ? 'Resetting…' : 'Reset'}
                </button>
                <button
                  type="button"
                  onClick={closeReset}
                  className="text-xs underline"
                >
                  Cancel
                </button>
                {resetError && (
                  <p className="basis-full text-xs text-red-600">{resetError}</p>
                )}
              </form>
            )}
          </div>
        )}
      </section>

      <section className="bg-white dark:bg-slate-800 rounded shadow p-4">
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
