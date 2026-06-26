import { useEffect, useState, type FormEvent } from 'react';
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
                      <span className="block text-xs text-slate-500">Team name</span>
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
                              className="w-full text-start px-3 py-1.5 text-danger hover:bg-red-50"
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

              {removeTarget && removeBlockers && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="remove-member-title"
                >
                  <div className="bg-surface rounded-lg shadow-xl max-w-md w-full p-5">
                    <h3 id="remove-member-title" className="text-lg font-semibold mb-2">
                      {t('team.remove.confirm').replace('{name}', removeTarget.name)}
                    </h3>
                    {removeBlockers.ownedProjectCount > 0 && (
                      <p className="text-sm text-text mb-2">
                        {t('team.remove.ownsProjects')}
                      </p>
                    )}
                    {(removeBlockers.ownedProjects.length > 0 ||
                      removeBlockers.accountableProjects.length > 0) && (
                      <ul className="list-disc ps-5 space-y-0.5 mb-3 text-sm text-text">
                        {removeBlockers.ownedProjects.map((p) => (
                          <li key={p.id}>{p.name}</li>
                        ))}
                        {removeBlockers.accountableProjects.map((p) => (
                          <li key={p.id}>{p.name}</li>
                        ))}
                      </ul>
                    )}
                    {removeBlockers.ownedProjectCount > 0 && (
                      <div className="space-y-3 mb-4">
                        <label className="block text-sm">
                          {t('team.remove.reassignTo')}
                          <select
                            value={reassignOwnerTo}
                            onChange={(e) => {
                              setReassignOwnerTo(e.target.value);
                              if (e.target.value) setRemoveForce(false);
                            }}
                            className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                          >
                            <option value="">—</option>
                            {reassignOptions.map((m) => (
                              <option key={m.userId} value={m.userId}>
                                {m.name} ({m.email})
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center gap-2 text-sm text-danger">
                          <input
                            type="checkbox"
                            checked={removeForce}
                            onChange={(e) => {
                              setRemoveForce(e.target.checked);
                              if (e.target.checked) setReassignOwnerTo('');
                            }}
                          />
                          {t('team.remove.removeAnyway')}
                        </label>
                      </div>
                    )}
                    {removeError && <p className="text-xs text-danger mb-2" role="alert">{removeError}</p>}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={closeRemoveDialog}
                        className="border rounded px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-700"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={
                          removeMut.isPending ||
                          (removeBlockers.ownedProjectCount > 0 &&
                            !reassignOwnerTo &&
                            !removeForce)
                        }
                        onClick={confirmRemoveWithBlockers}
                        className="bg-danger text-white rounded px-3 py-1.5 text-sm disabled:opacity-50"
                      >
                        {removeMut.isPending ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

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
                      <div className="mb-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-warning">
                        <p className="font-medium mb-1">Cannot delete team because:</p>
                        <ul className="list-disc ps-5 space-y-0.5">
                          {detail.deleteBlockers.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {deleteError && <p className="text-xs text-danger mb-2" role="alert">{deleteError}</p>}
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
                        className="bg-danger text-white rounded px-3 py-1.5 text-sm disabled:opacity-50"
                      >
                        {deleteMut.isPending ? 'Deleting…' : 'Delete team'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <h3 className="text-sm font-medium mb-2">Members</h3>
              <div className="flex flex-wrap gap-2 mb-3">
                <input
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={t('team.members.search')}
                  className="flex-1 min-w-[12rem] rounded border border-border bg-surface px-2 py-1 text-sm"
                />
                <select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value as teamsApi.TeamRole | '')}
                  className="rounded border border-border bg-surface px-2 py-1 text-sm"
                  aria-label={t('team.members.filter.role')}
                >
                  <option value="">{t('team.members.filter.roleAll')}</option>
                  <option value="MANAGER">MANAGER</option>
                  <option value="MEMBER">MEMBER</option>
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as teamsApi.TeamMemberStatusFilter | '')
                  }
                  className="rounded border border-border bg-surface px-2 py-1 text-sm"
                  aria-label={t('team.members.filter.status')}
                >
                  <option value="">{t('team.members.filter.statusAll')}</option>
                  <option value="active">{t('team.members.filter.status.active')}</option>
                  <option value="disabled">{t('team.members.filter.status.disabled')}</option>
                  <option value="locked">{t('team.members.filter.status.locked')}</option>
                </select>
                <select
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value as teamsApi.TeamMemberKind)}
                  className="rounded border border-border bg-surface px-2 py-1 text-sm"
                  aria-label={t('team.members.filter.kind')}
                >
                  <option value="all">{t('team.members.filter.kind.all')}</option>
                  <option value="member">{t('team.members.filter.kind.member')}</option>
                  <option value="external">{t('team.members.filter.kind.external')}</option>
                </select>
              </div>

              {membersLoading && (
                <p className="text-sm text-slate-500 mb-4">{t('team.members.loading')}</p>
              )}
              {!membersLoading && roster.length === 0 && (
                <p className="text-sm text-slate-500 italic mb-4">{t('team.members.empty')}</p>
              )}

              {roster.length > 0 && (
                <table className="w-full text-sm mb-4">
                  <thead className="text-start text-xs text-slate-500 uppercase">
                    <tr>
                      <th className="py-1 pe-4">
                        <button type="button" onClick={() => toggleSort('name')} className="hover:underline">
                          {t('team.members.col.name')}
                          {sortIndicator('name')}
                        </button>
                      </th>
                      <th className="py-1 pe-4">
                        <button type="button" onClick={() => toggleSort('email')} className="hover:underline">
                          {t('team.members.col.email')}
                          {sortIndicator('email')}
                        </button>
                      </th>
                      <th className="py-1 pe-4">{t('team.members.col.status')}</th>
                      <th className="py-1 pe-4">
                        <button type="button" onClick={() => toggleSort('role')} className="hover:underline">
                          {t('team.members.col.role')}
                          {sortIndicator('role')}
                        </button>
                      </th>
                      <th className="py-1 pe-4">
                        <button type="button" onClick={() => toggleSort('joinedAt')} className="hover:underline">
                          {t('team.members.col.joined')}
                          {sortIndicator('joinedAt')}
                        </button>
                      </th>
                      {isManager && <th className="py-1">{t('team.members.col.action')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map((m) => (
                      <tr
                        key={m.userId}
                        className={`border-t border-border ${m.external ? 'bg-bg' : ''}`}
                      >
                        <td className="py-2 pe-4 font-medium">{m.name}</td>
                        <td className="py-2 pe-4 text-text">{m.email}</td>
                        <td className="py-2 pe-4">
                          <div className="flex flex-wrap gap-1">
                            <MemberStatusBadges member={m} t={t} />
                            {m.external && (
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
                            {!m.disabled && !m.locked && !m.external && (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pe-4">
                          {!m.external ? (
                            isManager && teamRoles.length > 0 ? (
                              <select
                                value={m.roleId ?? ''}
                                onChange={(e) =>
                                  updateRoleMut.mutate({
                                    userId: m.userId,
                                    roleId: e.target.value,
                                  })
                                }
                                disabled={updateRoleMut.isPending}
                                className="text-xs rounded border border-border bg-surface px-1 py-0.5"
                              >
                                {!m.roleId && <option value="">— ({m.role})</option>}
                                {teamRoles.map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.name}
                                    {r.isSystem ? ' (system)' : ''}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-xs uppercase tracking-wide text-slate-500">
                                {m.roleName ?? m.role}
                              </span>
                            )
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-2 pe-4 text-slate-500 text-xs" dir="rtl">
                          {formatShamsiTimestampDate(m.joinedAt)}
                        </td>
                        {isManager && (
                          <td className="py-2">
                            {!m.external && (
                              <button
                                type="button"
                                onClick={() => void beginRemoveMember(m)}
                                className="text-xs text-danger hover:underline disabled:opacity-50"
                                disabled={removeMut.isPending || removeBlockersLoading}
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {totalPages > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-text">
                  <span>
                    {t('team.members.pagination.pageOf')
                      .replace('{page}', String(currentPage))
                      .replace('{totalPages}', String(totalPages))}
                  </span>
                  <span className="text-xs text-slate-500">
                    {t('team.members.pagination.total').replace('{count}', String(totalItems))}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage <= 1 || membersFetching}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="text-xs underline disabled:opacity-40"
                  >
                    {t('team.members.pagination.prev')}
                  </button>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages || membersFetching}
                    onClick={() => setPage((p) => p + 1)}
                    className="text-xs underline disabled:opacity-40"
                  >
                    {t('team.members.pagination.next')}
                  </button>
                  <form onSubmit={submitJumpPage} className="flex items-center gap-1 text-xs">
                    <label htmlFor="team-members-jump">{t('team.members.pagination.jump')}</label>
                    <input
                      id="team-members-jump"
                      type="number"
                      min={1}
                      max={totalPages}
                      value={jumpPage}
                      onChange={(e) => setJumpPage(e.target.value)}
                      className="w-14 rounded border border-border bg-surface px-1 py-0.5"
                    />
                    <button type="submit" className="underline" disabled={membersFetching}>
                      {t('team.members.pagination.go')}
                    </button>
                  </form>
                </div>
              )}

              {isManager && (
                <div className="pt-4 border-t space-y-2">
                  <h3 className="text-sm font-medium">{t('team.addMember.search')}</h3>
                  <input
                    type="search"
                    value={addMemberQuery}
                    onChange={(e) => setAddMemberQuery(e.target.value)}
                    placeholder={t('team.addMember.searchPlaceholder')}
                    className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                    aria-label={t('team.addMember.search')}
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as teamsApi.TeamRole)}
                    className="rounded border border-border bg-surface px-2 py-1 text-sm"
                    aria-label={t('team.members.filter.role')}
                  >
                    <option value="MEMBER">MEMBER</option>
                    <option value="MANAGER">MANAGER</option>
                  </select>
                  {addMemberQuery.trim().length > 0 && addMemberQuery.trim().length < 2 && (
                    <p className="text-xs text-slate-500">{t('team.addMember.typeHint')}</p>
                  )}
                  {debouncedAddMemberQuery.length >= 2 && !addMemberSearching && addMemberHits.length === 0 && (
                    <p className="text-xs text-slate-500 italic">{t('team.addMember.noResults')}</p>
                  )}
                  {addMemberSearching && debouncedAddMemberQuery.length >= 2 && (
                    <p className="text-xs text-slate-500">{t('team.addMember.searching')}</p>
                  )}
                  {addMemberHits.length > 0 && (
                    <ul className="max-h-32 overflow-y-auto space-y-1 border border-border rounded p-2">
                      {addMemberHits.map((u) => (
                        <li key={u.id}>
                          {u.alreadyMember ? (
                            <span
                              className="text-xs text-slate-400 block py-0.5"
                              title={t('team.addMember.alreadyMember')}
                            >
                              {u.name} ({u.email}) — {t('team.addMember.alreadyMember')}
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={inviteMut.isPending}
                              className="text-xs w-full text-start hover:underline disabled:opacity-50 py-0.5"
                              onClick={() =>
                                inviteMut.mutate({ userId: u.id, role: inviteRole })
                              }
                            >
                              {u.name} ({u.email})
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {inviteError && <p className="text-xs text-danger" role="alert">{inviteError}</p>}
                  <p className="text-xs text-slate-500">{t('team.addMember.existingOnly')}</p>
                </div>
              )}

              {canManageGroups && currentTeamId && (
                <TeamGroupsPanel teamId={currentTeamId} />
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
