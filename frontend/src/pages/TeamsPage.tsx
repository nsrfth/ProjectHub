import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as teamsApi from '@/features/teams/api';
import * as rolesApi from '@/features/roles/api';
import { useTeams } from '@/features/teams/TeamsContext';
import { formatShamsiTimestampDate } from '@/lib/shamsi';
import { visibleTeamMembers } from '@/lib/systemUser';
import { useT } from '@/lib/i18n';
import TeamGroupsPanel from '@/features/groups/TeamGroupsPanel';

function MemberStatusBadges({ member, t }: { member: teamsApi.TeamMember; t: (k: string) => string }): JSX.Element | null {
  if (member.disabled) {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200">
        {t('team.member.status.disabled')}
      </span>
    );
  }
  if (member.locked) {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
        {t('team.member.status.locked')}
      </span>
    );
  }
  return null;
}

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function TeamsPage(): JSX.Element {
  const { teams, currentTeamId, setCurrentTeamId, refresh } = useTeams();
  const qc = useQueryClient();
  const t = useT();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (input: { name: string; slug: string }) => teamsApi.createTeam(input),
    onSuccess: async (team) => {
      setName('');
      setSlug('');
      setCreateError(null);
      await refresh();
      setCurrentTeamId(team.id);
    },
    onError: (err) => setCreateError(errorMessage(err, 'Could not create team')),
  });

  async function onCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    createMut.mutate({ name, slug });
  }

  // Detail panel for whichever team is currently selected.
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['teams', 'detail', currentTeamId],
    queryFn: () => teamsApi.getTeam(currentTeamId!),
    enabled: !!currentTeamId,
  });

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<teamsApi.TeamRole>('MEMBER');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const inviteMut = useMutation({
    mutationFn: (input: { email: string; role: teamsApi.TeamRole }) =>
      teamsApi.addMember(currentTeamId!, input),
    onSuccess: async () => {
      setInviteEmail('');
      setInviteError(null);
      await qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] });
    },
    onError: (err) => setInviteError(errorMessage(err, 'Could not add member')),
  });

  // v1.23: role catalogue for the role-change dropdown.
  const { data: rolesResp } = useQuery({
    queryKey: ['roles', currentTeamId],
    queryFn: () => rolesApi.listRoles(currentTeamId!),
    enabled: !!currentTeamId,
    staleTime: 30_000,
  });
  const teamRoles = rolesResp?.items ?? [];

  const updateRoleMut = useMutation({
    mutationFn: (args: { userId: string; roleId: string }) =>
      teamsApi.updateMemberRole(currentTeamId!, args.userId, { roleId: args.roleId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] });
    },
  });

  const removeMut = useMutation({
    mutationFn: (userId: string) => teamsApi.removeMember(currentTeamId!, userId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] });
    },
  });

  const isManager = detail?.myRole === 'MANAGER';
  const canEditDetails = detail?.capabilities?.editDetails ?? isManager;
  const canDelete = detail?.capabilities?.deleteTeam ?? false;
  const canManageGroups = detail?.capabilities?.manageGroups ?? false;

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const renameMut = useMutation({
    mutationFn: (name: string) => teamsApi.updateTeam(currentTeamId!, { name }),
    onSuccess: async () => {
      setEditingName(false);
      setRenameError(null);
      setShowActions(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] }),
        refresh(),
      ]);
    },
    onError: (err) => setRenameError(errorMessage(err, 'Could not rename team')),
  });

  const deleteMut = useMutation({
    mutationFn: () => teamsApi.deleteTeam(currentTeamId!),
    onSuccess: async () => {
      setShowDeleteDialog(false);
      setDeleteError(null);
      const remaining = teams.filter((t) => t.id !== currentTeamId);
      await refresh();
      setCurrentTeamId(remaining[0]?.id ?? null);
    },
    onError: (err) => setDeleteError(errorMessage(err, 'Could not delete team')),
  });

  function startRename(): void {
    if (!detail) return;
    setDraftName(detail.name);
    setRenameError(null);
    setEditingName(true);
    setShowActions(false);
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Teams</h1>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <aside className="md:col-span-1 bg-white rounded shadow p-4 space-y-4">
          <h2 className="font-medium">Your teams</h2>
          <ul className="space-y-1">
            {teams.length === 0 && (
              <li className="text-sm text-slate-500">No teams yet — create one.</li>
            )}
            {teams.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setCurrentTeamId(t.id)}
                  className={`w-full text-left rounded px-2 py-1 text-sm ${
                    t.id === currentTeamId ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
                  }`}
                >
                  {t.name}
                  <span className="ml-2 text-xs opacity-70">{t.myRole}</span>
                </button>
              </li>
            ))}
          </ul>

          <form onSubmit={onCreate} className="pt-4 border-t space-y-2">
            <h3 className="text-sm font-medium">New team</h3>
            <input
              type="text"
              required
              placeholder="Team name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border-slate-300 px-2 py-1 border text-sm"
            />
            <input
              type="text"
              required
              placeholder="slug-like-this"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              className="w-full rounded border-slate-300 px-2 py-1 border text-sm font-mono"
            />
            {createError && <p className="text-xs text-red-600">{createError}</p>}
            <button
              type="submit"
              disabled={createMut.isPending}
              className="w-full bg-slate-900 text-white rounded py-1 text-sm font-medium disabled:opacity-50"
            >
              {createMut.isPending ? 'Creating…' : 'Create'}
            </button>
          </form>
        </aside>

        <main className="md:col-span-2 bg-white rounded shadow p-4">
          {!currentTeamId && <p className="text-sm text-slate-500">Select or create a team.</p>}
          {currentTeamId && detailLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {detail && (
            <>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <form
                      className="space-y-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const trimmed = draftName.trim();
                        if (!trimmed) {
                          setRenameError('Team name cannot be empty');
                          return;
                        }
                        renameMut.mutate(trimmed);
                      }}
                    >
                      <label className="block text-xs text-slate-500">Team name</label>
                      <input
                        type="text"
                        required
                        maxLength={120}
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        className="w-full rounded border-slate-300 px-2 py-1 border text-sm"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={renameMut.isPending}
                          className="bg-slate-900 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingName(false);
                            setRenameError(null);
                          }}
                          className="border rounded px-3 py-1 text-sm hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                      {renameError && <p className="text-xs text-red-600">{renameError}</p>}
                    </form>
                  ) : (
                    <>
                      <h2 className="text-lg font-medium flex items-center gap-2">
                        {detail.color && (
                          <span
                            aria-hidden
                            className="inline-block w-4 h-4 rounded-full border border-slate-200"
                            style={{ background: detail.color }}
                          />
                        )}
                        {detail.name}
                      </h2>
                      <p className="text-xs font-mono text-slate-500">{detail.slug}</p>
                    </>
                  )}
                </div>
                <div className="flex items-start gap-2 shrink-0">
                  {canEditDetails && !editingName && <TeamColourPicker team={detail} />}
                  {(canEditDetails || canDelete) && !editingName && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowActions((v) => !v)}
                        className="px-2 py-1 border rounded text-sm hover:bg-slate-50"
                        aria-label="Team actions"
                        aria-expanded={showActions}
                      >
                        ⋮
                      </button>
                      {showActions && (
                        <div className="absolute right-0 z-10 mt-1 w-40 rounded border border-slate-200 bg-white shadow-lg py-1 text-sm">
                          {canEditDetails && (
                            <button
                              type="button"
                              onClick={startRename}
                              className="w-full text-left px-3 py-1.5 hover:bg-slate-50"
                            >
                              Rename team
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteError(null);
                                setShowDeleteDialog(true);
                                setShowActions(false);
                              }}
                              className="w-full text-left px-3 py-1.5 text-red-600 hover:bg-red-50"
                            >
                              Delete team
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {showDeleteDialog && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="delete-team-title"
                >
                  <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
                    <h3 id="delete-team-title" className="text-lg font-semibold mb-2">
                      Delete team
                    </h3>
                    <p className="text-sm text-slate-600 mb-3">
                      Are you sure you want to delete <strong>{detail.name}</strong>? This action
                      cannot be undone.
                    </p>
                    {detail.deleteBlockers && !detail.deleteBlockers.canDelete && (
                      <div className="mb-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        <p className="font-medium mb-1">Cannot delete team because:</p>
                        <ul className="list-disc pl-5 space-y-0.5">
                          {detail.deleteBlockers.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {deleteError && <p className="text-xs text-red-600 mb-2">{deleteError}</p>}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setShowDeleteDialog(false);
                          setDeleteError(null);
                        }}
                        className="border rounded px-3 py-1.5 text-sm hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={
                          deleteMut.isPending ||
                          (detail.deleteBlockers !== null && !detail.deleteBlockers.canDelete)
                        }
                        onClick={() => deleteMut.mutate()}
                        className="bg-red-600 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50"
                      >
                        {deleteMut.isPending ? 'Deleting…' : 'Delete team'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {(() => {
                const roster = visibleTeamMembers(detail.members);
                const regularMembers = roster.filter((m) => !m.external);
                const externalMembers = roster.filter((m) => m.external);

                function renderMemberRow(m: teamsApi.TeamMember, externalRow: boolean): JSX.Element {
                  return (
                    <li
                      key={m.userId}
                      className={`flex items-center justify-between text-sm border-b last:border-0 py-1 ${
                        externalRow ? 'bg-slate-50/80 dark:bg-slate-900/30' : ''
                      }`}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{m.name}</span>
                        <span className="text-slate-500">{m.email}</span>
                        <MemberStatusBadges member={m} t={t} />
                        {externalRow && (
                          <>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200">
                              {t('team.member.external')}
                            </span>
                            {m.groupAccessLevel && (
                              <span className="text-xs text-slate-500">
                                {m.groupAccessLevel === 'FULL'
                                  ? t('team.member.access.full')
                                  : t('team.member.access.readonly')}
                              </span>
                            )}
                          </>
                        )}
                        {!externalRow && (
                          <span className="text-xs text-slate-400" dir="rtl">
                            {formatShamsiTimestampDate(m.joinedAt)}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        {!externalRow && isManager && teamRoles.length > 0 ? (
                          <select
                            value={m.roleId ?? ''}
                            onChange={(e) =>
                              updateRoleMut.mutate({
                                userId: m.userId,
                                roleId: e.target.value,
                              })
                            }
                            disabled={updateRoleMut.isPending}
                            className="text-xs rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-1 py-0.5"
                            title="Change role"
                          >
                            {!m.roleId && <option value="">— ({m.role})</option>}
                            {teamRoles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                                {r.isSystem ? ' (system)' : ''}
                              </option>
                            ))}
                          </select>
                        ) : !externalRow ? (
                          <span className="text-xs uppercase tracking-wide text-slate-500">
                            {m.roleName ?? m.role}
                          </span>
                        ) : null}
                        {!externalRow && isManager && (
                          <button
                            onClick={() => removeMut.mutate(m.userId)}
                            className="text-xs text-red-600 hover:underline disabled:opacity-50"
                            disabled={removeMut.isPending}
                          >
                            Remove
                          </button>
                        )}
                      </span>
                    </li>
                  );
                }

                return (
                  <>
                    <h3 className="text-sm font-medium mb-2">Members</h3>
                    <ul className="space-y-1 mb-4">
                      {regularMembers.map((m) => renderMemberRow(m, false))}
                    </ul>
                    {externalMembers.length > 0 && (
                      <>
                        <h3 className="text-sm font-medium mb-2 text-slate-600 dark:text-slate-300">
                          {t('team.member.externalSection')}
                        </h3>
                        <ul className="space-y-1 mb-4 border-s border-slate-200 dark:border-slate-600 ps-3">
                          {externalMembers.map((m) => renderMemberRow(m, true))}
                        </ul>
                      </>
                    )}
                  </>
                );
              })()}

              {isManager && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    inviteMut.mutate({ email: inviteEmail, role: inviteRole });
                  }}
                  className="pt-4 border-t space-y-2"
                >
                  <h3 className="text-sm font-medium">Add member</h3>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      required
                      placeholder="user@example.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      className="flex-1 rounded border-slate-300 px-2 py-1 border text-sm"
                    />
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as teamsApi.TeamRole)}
                      className="rounded border-slate-300 px-2 py-1 border text-sm"
                    >
                      <option value="MEMBER">MEMBER</option>
                      <option value="MANAGER">MANAGER</option>
                    </select>
                    <button
                      type="submit"
                      disabled={inviteMut.isPending}
                      className="bg-slate-900 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                  {inviteError && <p className="text-xs text-red-600">{inviteError}</p>}
                  <p className="text-xs text-slate-500">
                    The user must already have a TaskHub account.
                  </p>
                </form>
              )}

              {canManageGroups && currentTeamId && (
                <TeamGroupsPanel teamId={currentTeamId} members={detail.members} />
              )}
            </>
          )}
        </main>
      </section>
    </div>
  );
}

// v1.12: per-team accent colour picker (manager-only). 8 preset swatches +
// a native colour input for arbitrary values. Saves through teamsApi.updateTeam
// + invalidates the cached detail / list so the new value lands everywhere.
const PRESET_COLOURS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#14b8a6', '#64748b',
];

function TeamColourPicker({ team }: { team: teamsApi.TeamDetail }): JSX.Element {
  const qc = useQueryClient();
  const { refresh } = useTeams();
  const updateMut = useMutation({
    mutationFn: (color: string | null) => teamsApi.updateTeam(team.id, { color }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['teams', 'detail', team.id] }),
        refresh(),
      ]);
    },
  });
  const current = team.color ?? '';
  return (
    <div className="flex items-center gap-1">
      {PRESET_COLOURS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Set colour ${c}`}
          onClick={() => updateMut.mutate(c)}
          className={`w-5 h-5 rounded-full border ${current === c ? 'ring-2 ring-offset-1 ring-slate-900' : 'border-slate-200'}`}
          style={{ background: c }}
        />
      ))}
      <input
        type="color"
        value={current || '#000000'}
        onChange={(e) => updateMut.mutate(e.target.value)}
        title="Custom colour"
        className="w-5 h-5 rounded border border-slate-200 cursor-pointer"
      />
      {team.color && (
        <button
          type="button"
          onClick={() => updateMut.mutate(null)}
          title="Clear colour"
          className="text-xs text-slate-500 underline ml-1"
        >
          clear
        </button>
      )}
    </div>
  );
}
