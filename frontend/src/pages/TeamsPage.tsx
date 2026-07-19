import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as teamsApi from '@/features/teams/api';
import * as rolesApi from '@/features/roles/api';
import { useTeams } from '@/features/teams/TeamsContext';
import { formatShamsiTimestampDate } from '@/lib/shamsi';
import { visibleTeamMembers } from '@/lib/systemUser';
import { useT } from '@/lib/i18n';
import TeamGroupsPanel from '@/features/groups/TeamGroupsPanel';
import { displayRoleName } from '@/lib/displayRoleName';
import { deriveDeputies, systemRoleId } from '@/lib/deputies';

function MemberStatusBadges({ member, t }: { member: teamsApi.TeamMember; t: (k: string) => string }): JSX.Element | null {
  if (member.disabled) {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded bg-danger/10 text-danger">
        {t('team.member.status.disabled')}
      </span>
    );
  }
  if (member.locked) {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning">
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
  // v2.10 (Q1): division-page tabs, persisted in the URL like TasksPage's view.
  const [searchParams, setSearchParams] = useSearchParams();
  // v2.12: the Members tab is gone — departments are where people are
  // managed (adding to a department auto-joins the division). Old ?tab=members
  // links fall through to the default.
  const rawTab = searchParams.get('tab');
  const activeTab: 'units' | 'groups' = rawTab === 'groups' ? 'groups' : 'units';
  const setActiveTab = (tab: 'units' | 'groups'): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (tab === 'units') next.delete('tab');
        else next.set('tab', tab);
        return next;
      },
      { replace: true },
    );
  };

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

  const [addMemberQuery, setAddMemberQuery] = useState('');
  const [debouncedAddMemberQuery, setDebouncedAddMemberQuery] = useState('');
  const [inviteRole, setInviteRole] = useState<teamsApi.TeamRole>('MEMBER');
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedAddMemberQuery(addMemberQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [addMemberQuery]);

  const { data: addMemberHits = [], isFetching: addMemberSearching } = useQuery({
    queryKey: ['teams', currentTeamId, 'add-member-search', debouncedAddMemberQuery],
    queryFn: () => teamsApi.searchAddableUsers(currentTeamId!, debouncedAddMemberQuery),
    enabled: !!currentTeamId && debouncedAddMemberQuery.length >= 2,
  });

  const inviteMut = useMutation({
    mutationFn: (input: { userId: string; role: teamsApi.TeamRole }) =>
      teamsApi.addMember(currentTeamId!, { userId: input.userId, role: input.role }),
    onSuccess: async () => {
      setAddMemberQuery('');
      setDebouncedAddMemberQuery('');
      setInviteError(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] }),
        qc.invalidateQueries({ queryKey: ['teams', currentTeamId, 'members'] }),
        qc.invalidateQueries({ queryKey: ['teams', currentTeamId, 'assignees'] }),
        qc.invalidateQueries({ queryKey: ['teams', currentTeamId, 'add-member-search'] }),
      ]);
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
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] }),
        qc.invalidateQueries({ queryKey: ['teams', currentTeamId, 'members'] }),
      ]);
    },
  });

  const DEFAULT_PAGE_SIZE = 25;
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(DEFAULT_PAGE_SIZE);
  const [roleFilter, setRoleFilter] = useState<teamsApi.TeamRole | ''>('');
  const [statusFilter, setStatusFilter] = useState<teamsApi.TeamMemberStatusFilter | ''>('');
  const [kindFilter, setKindFilter] = useState<teamsApi.TeamMemberKind>('all');
  const [sortBy, setSortBy] = useState<teamsApi.TeamMemberSortBy>('joinedAt');
  const [sortDir, setSortDir] = useState<teamsApi.SortDir>('asc');
  const [jumpPage, setJumpPage] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [search, roleFilter, statusFilter, kindFilter, sortBy, sortDir, currentTeamId]);

  const listParams: teamsApi.ListTeamMembersParams = {
    page,
    pageSize,
    search: search || undefined,
    role: roleFilter || undefined,
    status: statusFilter || undefined,
    kind: kindFilter,
    sortBy,
    sortDir,
  };

  const { data: membersPage, isLoading: membersLoading, isFetching: membersFetching } = useQuery({
    queryKey: ['teams', currentTeamId, 'members', listParams],
    queryFn: () => teamsApi.listTeamMembers(currentTeamId!, listParams),
    enabled: !!currentTeamId,
  });

  const roster = visibleTeamMembers(membersPage?.items ?? []);
  // v2.11: unpaginated roster for the deputies row — the paged `roster` above
  // could hide a deputy sitting on page 2.
  const { data: fullRoster = [] } = useQuery({
    queryKey: ['teams', currentTeamId, 'assignees'],
    queryFn: () => teamsApi.listTeamMembersForAssignees(currentTeamId!),
    enabled: !!currentTeamId,
  });
  const allMembers = visibleTeamMembers(fullRoster);
  const totalPages = membersPage?.totalPages ?? 0;
  const totalItems = membersPage?.totalItems ?? 0;
  const currentPage = membersPage?.page ?? page;

  function toggleSort(column: teamsApi.TeamMemberSortBy): void {
    if (sortBy === column) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDir('asc');
    }
  }

  function sortIndicator(column: teamsApi.TeamMemberSortBy): string {
    if (sortBy !== column) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  function submitJumpPage(e: FormEvent): void {
    e.preventDefault();
    const n = Number.parseInt(jumpPage, 10);
    if (!Number.isFinite(n) || n < 1) return;
    setPage(Math.min(n, Math.max(1, totalPages)));
    setJumpPage('');
  }

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
  const [removeTarget, setRemoveTarget] = useState<teamsApi.TeamMember | null>(null);
  const [removeBlockers, setRemoveBlockers] = useState<teamsApi.MemberRemovalBlockers | null>(null);
  const [removeBlockersLoading, setRemoveBlockersLoading] = useState(false);
  const [reassignOwnerTo, setReassignOwnerTo] = useState('');
  const [removeForce, setRemoveForce] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const { data: reassignCandidates = [] } = useQuery({
    queryKey: ['teams', currentTeamId, 'assignees'],
    queryFn: () => teamsApi.listTeamMembersForAssignees(currentTeamId!),
    enabled: !!currentTeamId && !!removeTarget,
  });

  const reassignOptions = reassignCandidates.filter((m) => m.userId !== removeTarget?.userId);

  async function invalidateMemberLists(): Promise<void> {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['teams', 'detail', currentTeamId] }),
      qc.invalidateQueries({ queryKey: ['teams', currentTeamId, 'members'] }),
      qc.invalidateQueries({ queryKey: ['teams', currentTeamId, 'assignees'] }),
    ]);
  }

  const removeMut = useMutation({
    mutationFn: (input: { userId: string; opts?: teamsApi.RemoveMemberOptions }) =>
      teamsApi.removeMember(currentTeamId!, input.userId, input.opts),
    onSuccess: async () => {
      closeRemoveDialog();
      await invalidateMemberLists();
    },
    onError: (err) => setRemoveError(errorMessage(err, 'Could not remove member')),
  });

  async function beginRemoveMember(member: teamsApi.TeamMember): Promise<void> {
    if (!currentTeamId) return;
    setRemoveError(null);
    setReassignOwnerTo('');
    setRemoveForce(false);
    setRemoveBlockersLoading(true);
    try {
      const blockers = await teamsApi.getMemberRemovalBlockers(currentTeamId, member.userId);
      const hasBlockers =
        blockers.ownedProjectCount > 0 || blockers.accountableProjectCount > 0;
      if (!hasBlockers) {
        const msg = t('team.remove.confirm').replace('{name}', member.name);
        if (window.confirm(msg)) {
          removeMut.mutate({ userId: member.userId });
        }
        return;
      }
      setRemoveTarget(member);
      setRemoveBlockers(blockers);
    } catch (err) {
      window.alert(errorMessage(err, 'Could not load removal blockers'));
    } finally {
      setRemoveBlockersLoading(false);
    }
  }

  function closeRemoveDialog(): void {
    setRemoveTarget(null);
    setRemoveBlockers(null);
    setRemoveError(null);
    setReassignOwnerTo('');
    setRemoveForce(false);
  }

  function confirmRemoveWithBlockers(): void {
    if (!removeTarget || !removeBlockers) return;
    if (removeBlockers.ownedProjectCount > 0 && !reassignOwnerTo && !removeForce) return;
    removeMut.mutate({
      userId: removeTarget.userId,
      opts: {
        ...(reassignOwnerTo ? { reassignOwnerTo } : {}),
        ...(removeForce ? { force: true } : {}),
      },
    });
  }

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
    <div className="p-8">
      <h1 className="text-2xl font-semibold mb-6">{t('team.page.title')}</h1>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <aside className="md:col-span-1 bg-white rounded shadow p-4 space-y-4">
          <h2 className="font-medium">{t('team.page.yourTeams')}</h2>
          <ul className="space-y-1">
            {teams.length === 0 && (
              <li className="text-sm text-slate-500">No teams yet — create one.</li>
            )}
            {teams.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setCurrentTeamId(t.id)}
                  className={`w-full text-start rounded px-2 py-1 text-sm ${
                    t.id === currentTeamId ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
                  }`}
                >
                  {t.name}
                  <span className="ms-2 text-xs opacity-70">{t.myRole}</span>
                </button>
              </li>
            ))}
          </ul>

          <form onSubmit={onCreate} className="pt-4 border-t space-y-2">
            <h3 className="text-sm font-medium">New team</h3>
            <input
              type="text"
              required
              placeholder={t('team.placeholder.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border-slate-300 px-2 py-1 border text-sm"
            />
            <input
              type="text"
              required
              placeholder={t('team.placeholder.slug')}
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              className="w-full rounded border-slate-300 px-2 py-1 border text-sm font-mono"
            />
            {createError && <p className="text-xs text-danger" role="alert">{createError}</p>}
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
          {!currentTeamId && <p className="text-sm text-slate-500">{t('team.page.selectHint')}</p>}
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
                          setRenameError(t('team.rename.emptyError'));
                          return;
                        }
                        renameMut.mutate(trimmed);
                      }}
                    >
                      <span className="block text-xs text-slate-500">{t('team.placeholder.name')}</span>
                      <input
                        type="text"
                        required
                        maxLength={120}
                        aria-label="Team name"
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
                      {renameError && <p className="text-xs text-danger" role="alert">{renameError}</p>}
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
                        <div className="absolute end-0 z-10 mt-1 w-40 rounded border border-slate-200 bg-white shadow-lg py-1 text-sm">
                          {canEditDetails && (
                            <button
                              type="button"
                              onClick={startRename}
                              className="w-full text-start px-3 py-1.5 hover:bg-slate-50"
                            >
                              {t('team.actions.rename')}
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
                              className="w-full text-start px-3 py-1.5 text-danger hover:bg-red-50"
                            >
                              {t('team.actions.delete')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* v2.10 (Q1): اعضا | ادارات کل | گروه‌های همکاری */}
              <div className="mb-4 inline-flex rounded border border-border overflow-hidden" role="tablist">
                {([
                  ['units', 'tabs.team.units'],
                  ['groups', 'tabs.team.collabGroups'],
                ] as const).map(([tab, key], i) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    onClick={() => setActiveTab(tab)}
                    data-testid={`team-tab-${tab}`}
                    className={`px-4 py-1.5 text-sm ${i > 0 ? 'border-s border-border ' : ''}${
                      activeTab === tab
                        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                        : 'bg-surface text-text hover:bg-bg-elevated'
                    }`}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>

              {/* v2.11: the division's deputies, first-class. */}
              {(() => {
                const deputies = deriveDeputies(allMembers, teamRoles);
                const managerRoleId = systemRoleId(teamRoles, 'manager');
                const memberRoleId = systemRoleId(teamRoles, 'member');
                const candidates = allMembers.filter(
                  (m) => !m.external && m.roleId !== managerRoleId,
                );
                return (
                  <div className="mb-4 flex flex-wrap items-center gap-2 text-sm" data-testid="deputies-row">
                    <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                      {t('team.deputies.title')}
                    </span>
                    {deputies.length === 0 && (
                      <span className="text-xs text-slate-400">{t('team.deputies.none')}</span>
                    )}
                    {deputies.map((d) => (
                      <span
                        key={d.userId}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5"
                      >
                        {d.name}
                        {isManager && memberRoleId && (
                          <button
                            type="button"
                            title={t('team.deputies.remove')}
                            className="text-slate-400 hover:text-danger"
                            onClick={() => {
                              if (window.confirm(t('team.deputies.removeConfirm').replace('{name}', d.name)))
                                updateRoleMut.mutate({ userId: d.userId, roleId: memberRoleId });
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                    {isManager && managerRoleId && candidates.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          if (e.target.value)
                            updateRoleMut.mutate({ userId: e.target.value, roleId: managerRoleId });
                        }}
                        className="text-xs rounded border border-border bg-surface px-1 py-0.5"
                        data-testid="deputy-add"
                      >
                        <option value="">{t('team.deputies.add')}</option>
                        {candidates.map((m) => (
                          <option key={m.userId} value={m.userId}>{m.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })()}

              {/* v2.12: division member management now lives in the departments. */}

              {activeTab === 'units' && canManageGroups && currentTeamId && (
                <TeamGroupsPanel teamId={currentTeamId} kind="UNIT" />
              )}
              {activeTab === 'groups' && canManageGroups && currentTeamId && (
                <TeamGroupsPanel teamId={currentTeamId} kind="COLLAB" />
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
          disabled={updateMut.isPending}
          onClick={() => updateMut.mutate(c)}
          className={`w-5 h-5 rounded-full border disabled:opacity-50 ${current === c ? 'ring-2 ring-offset-1 ring-slate-900' : 'border-slate-200'}`}
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
          disabled={updateMut.isPending}
          onClick={() => updateMut.mutate(null)}
          title="Clear colour"
          className="text-xs text-slate-500 underline ms-1 disabled:opacity-50"
        >
          clear
        </button>
      )}
    </div>
  );
}
