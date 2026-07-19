import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as groupsApi from '@/features/groups/api';
import * as projectsApi from '@/features/projects/api';
import { listTeamMembersForAssignees, updateMemberRole, type TeamMember } from '@/features/teams/api';
import * as rolesApi from '@/features/roles/api';
import { tierRoles } from '@/lib/deputies';
import { useT } from '@/lib/i18n';
import { groupRoleLabelKey } from '@/lib/displayRoleName';
import { visibleTeamMembers } from '@/lib/systemUser';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

/**
 * v2.10 (nomenclature wave): kind-aware. One component, two renderings:
 *
 *   kind="UNIT"   — the Departments (ادارات کل) tab. Direct membership only,
 *                   no invitation flow, no access levels (server pins FULL),
 *                   MANAGER badge means the department director («مدیرکل»),
 *                   one-department-per-person surfaced as a friendly 409.
 *   kind="COLLAB" — the original collaboration-groups behaviour, untouched.
 *
 * The constraints themselves live server-side (v2.7.0); this component only
 * surfaces them.
 */
export default function TeamGroupsPanel({
  teamId,
  kind,
}: {
  teamId: string;
  kind: groupsApi.UserGroupKind;
}): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const isUnit = kind === 'UNIT';
  const L = (unitKey: string, groupKey: string): string => t(isUnit ? unitKey : groupKey);

  const { data: rosterMembers = [] } = useQuery({
    queryKey: ['teams', teamId, 'assignees'],
    queryFn: () => listTeamMembersForAssignees(teamId),
  });
  // v2.14: division role catalogue, for the department tier picker.
  const { data: rolesResp } = useQuery({
    queryKey: ['roles', teamId],
    queryFn: () => rolesApi.listRoles(teamId),
    staleTime: 30_000,
  });
  const divisionRoles = rolesResp?.items ?? [];
  const visibleMembers = visibleTeamMembers(rosterMembers);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [userQuery, setUserQuery] = useState('');
  const [addAccess, setAddAccess] = useState<groupsApi.GroupAccessLevel>('FULL');

  const { data: allGroups = [], isLoading } = useQuery({
    queryKey: ['groups', teamId],
    queryFn: () => groupsApi.listGroups(teamId),
  });
  const groups = allGroups.filter((g) => g.kind === kind);

  const { data: teamProjects = [] } = useQuery({
    queryKey: ['projects', teamId],
    queryFn: () => projectsApi.listProjects(teamId),
    enabled: !!selectedId,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['groups', teamId, selectedId],
    queryFn: () => groupsApi.getGroup(teamId, selectedId!),
    enabled: !!selectedId,
  });

  const { data: searchHits = [] } = useQuery({
    queryKey: ['groups', teamId, 'user-search', userQuery],
    queryFn: () => groupsApi.searchUsers(teamId, userQuery),
    enabled: userQuery.trim().length >= 2,
  });

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['groups', teamId] });
    // Tier changes live on the TEAM roster (roleId), which also feeds the
    // deputies row — refresh it alongside the group detail.
    await qc.invalidateQueries({ queryKey: ['teams', teamId, 'assignees'] });
    if (selectedId) await qc.invalidateQueries({ queryKey: ['groups', teamId, selectedId] });
  };

  const createMut = useMutation({
    mutationFn: () =>
      groupsApi.createGroup(teamId, { name: newName.trim(), description: newDesc || null, kind }),
    onSuccess: async (g) => {
      setNewName('');
      setNewDesc('');
      setCreateError(null);
      setSelectedId(g.id);
      await invalidate();
    },
    onError: (err) => setCreateError(errorMessage(err, t('groups.createFailed'))),
  });

  const deleteMut = useMutation({
    mutationFn: (groupId: string) => groupsApi.deleteGroup(teamId, groupId),
    onSuccess: async () => {
      setSelectedId(null);
      await invalidate();
    },
  });

  const setProjectsMut = useMutation({
    mutationFn: (projectIds: string[]) => groupsApi.setGroupProjects(teamId, selectedId!, projectIds),
    onSuccess: invalidate,
  });

  return (
    <section className="mt-6 pt-6 border-t">
      <h3 className="font-medium mb-2">{L('units.title', 'groups.title')}</h3>
      <p className="text-xs text-text-muted mb-3">{L('units.description', 'groups.description')}</p>

      <form
        className="flex flex-wrap gap-2 mb-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          createMut.mutate();
        }}
      >
        <input
          type="text"
          required
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={L('units.namePlaceholder', 'groups.namePlaceholder')}
          className="rounded border px-2 py-1 text-sm bg-surface flex-1 min-w-[10rem]"
          data-testid={isUnit ? 'unit-name-input' : 'group-name-input'}
        />
        <input
          type="text"
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          placeholder={t('groups.descPlaceholder')}
          className="rounded border px-2 py-1 text-sm bg-surface flex-1 min-w-[10rem]"
        />
        <button
          type="submit"
          disabled={createMut.isPending || !newName.trim()}
          className="text-sm bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 disabled:opacity-50"
        >
          {L('units.create', 'groups.create')}
        </button>
      </form>
      {createError && <p role="alert" className="text-xs text-danger mb-2">{createError}</p>}

      {isLoading && <p className="text-sm text-slate-500">{t('groups.loading')}</p>}
      {!isLoading && groups.length === 0 && (
        <p className="text-sm text-slate-500">{L('units.empty', 'groups.empty')}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ul className="space-y-1 text-sm">
          {groups.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => setSelectedId(g.id)}
                className={`w-full text-start rounded px-2 py-1 ${
                  selectedId === g.id ? 'bg-slate-900 text-white' : 'hover:bg-bg-elevated'
                }`}
              >
                {g.name}
                <span className="ms-2 text-xs opacity-70">
                  {g.memberCount} · {g.grantedProjectCount}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {selectedId && detail && !detailLoading && detail.kind === kind && (
          <GroupEditor
            teamId={teamId}
            kind={kind}
            detail={detail}
            teamMembers={visibleMembers}
            divisionRoles={divisionRoles}
            projects={teamProjects}
            userQuery={userQuery}
            setUserQuery={setUserQuery}
            searchHits={searchHits}
            addAccess={addAccess}
            setAddAccess={setAddAccess}
            onDelete={() => {
              if (window.confirm(L('units.confirmDelete', 'groups.confirmDelete')))
                deleteMut.mutate(selectedId);
            }}
            onSaveProjects={(ids) => setProjectsMut.mutate(ids)}
            onInvalidate={invalidate}
            deletePending={deleteMut.isPending}
            savePending={setProjectsMut.isPending}
          />
        )}
      </div>
    </section>
  );
}

function GroupEditor({
  teamId,
  kind,
  detail,
  teamMembers,
  divisionRoles,
  projects,
  userQuery,
  setUserQuery,
  searchHits,
  addAccess,
  setAddAccess,
  onDelete,
  onSaveProjects,
  onInvalidate,
  deletePending,
  savePending,
}: {
  teamId: string;
  kind: groupsApi.UserGroupKind;
  detail: groupsApi.UserGroupDetail;
  teamMembers: TeamMember[];
  divisionRoles: { id: string; name: string; isSystem: boolean }[];
  projects: projectsApi.Project[];
  userQuery: string;
  setUserQuery: (v: string) => void;
  searchHits: groupsApi.UserSearchHit[];
  addAccess: groupsApi.GroupAccessLevel;
  setAddAccess: (v: groupsApi.GroupAccessLevel) => void;
  onDelete: () => void;
  onSaveProjects: (ids: string[]) => void;
  onInvalidate: () => Promise<void>;
  deletePending: boolean;
  savePending: boolean;
}): JSX.Element {
  const t = useT();
  const isUnit = kind === 'UNIT';
  const [projectIds, setProjectIds] = useState<Set<string>>(new Set());
  const [memberError, setMemberError] = useState<string | null>(null);

  useEffect(() => {
    setProjectIds(new Set(detail.projects.map((p) => p.projectId)));
  }, [detail.id, detail.projects]);

  const memberIds = new Set(detail.members.map((m) => m.userId));
  const teamPickList = teamMembers.filter((m) => !memberIds.has(m.userId));
  // v2.14: department members carry one of two division tiers. Resolved per
  // division by name (they are data roles); the picker hides if the division
  // has neither.
  const { supervisorId, specialistId } = tierRoles(divisionRoles);
  const rosterByUser = new Map(teamMembers.map((m) => [m.userId, m]));
  const setTier = (userId: string, roleId: string): void => {
    setMemberError(null);
    void updateMemberRole(teamId, userId, { roleId })
      .then(onInvalidate)
      .catch((err) => setMemberError(errorMessage(err, t('groups.createFailed'))));
  };

  // v2.10: the one-department-per-person 409 gets the friendly message; other
  // failures show the server's own wording.
  const addMember = (userId: string): void => {
    setMemberError(null);
    void groupsApi
      .addGroupMember(teamId, detail.id, userId, isUnit ? 'FULL' : addAccess)
      .then(onInvalidate)
      .catch((err) => {
        if (isUnit && axios.isAxiosError(err) && err.response?.status === 409) {
          setMemberError(t('units.conflict.oneUnit'));
        } else {
          setMemberError(errorMessage(err, t('groups.createFailed')));
        }
      });
  };

  return (
    <div className="border rounded p-3 text-sm space-y-3 border-border">
      <div className="flex justify-between items-start gap-2">
        <div>
          <p className="font-medium">{detail.name}</p>
          {detail.description && (
            <p className="text-xs text-slate-500 mt-0.5">{detail.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={deletePending}
          className="text-xs text-danger hover:underline disabled:opacity-50"
        >
          {t('groups.delete')}
        </button>
      </div>

      <div>
        {isUnit && detail.members.length > 0 && (
          <label className="block mb-2">
            <span className="block text-xs font-medium text-slate-500 mb-1">
              {t('units.memberRole.manager')}
            </span>
            <select
              value={detail.members.find((m) => m.role === 'MANAGER')?.userId ?? ''}
              onChange={(e) => {
                const nextId = e.target.value;
                if (!nextId) return;
                setMemberError(null);
                const demote = detail.members
                  .filter((m) => m.role === 'MANAGER' && m.userId !== nextId)
                  .map((m) =>
                    groupsApi.updateGroupMemberRole(teamId, detail.id, m.userId, 'MEMBER'),
                  );
                void Promise.all(demote)
                  .then(() => groupsApi.updateGroupMemberRole(teamId, detail.id, nextId, 'MANAGER'))
                  .then(onInvalidate)
                  .catch((err) => setMemberError(errorMessage(err, t('groups.createFailed'))));
              }}
              className="w-full rounded border px-2 py-1 text-xs bg-surface"
              data-testid="unit-manager-picker"
            >
              <option value="">{t('units.manager.pick')}</option>
              {detail.members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.name}</option>
              ))}
            </select>
          </label>
        )}
        <p className="text-xs font-medium text-slate-500 mb-1">{t('groups.members')}</p>
        {memberError && <p role="alert" className="text-xs text-danger mb-1">{memberError}</p>}
        <ul className="space-y-1 mb-2">
          {detail.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid="group-member-row">
              <span>{m.name}</span>
              <span className="text-slate-400">{m.email}</span>
              {m.role === 'MANAGER' && (
                <span className="rounded bg-primary/10 text-primary px-1 font-medium">
                  {t(groupRoleLabelKey(kind, 'MANAGER'))}
                </span>
              )}
              {!isUnit && m.external && (
                <span className="rounded bg-amber-100 text-amber-900 px-1">{t('groups.external')}</span>
              )}
              {!isUnit && m.status === 'PENDING' && (
                <span className="rounded bg-slate-200 px-1">{t('groups.invite.pending')}</span>
              )}
              {!isUnit && m.status === 'DECLINED' && (
                <span className="rounded bg-red-100 text-red-800 px-1">{t('groups.invite.declined')}</span>
              )}
              {isUnit ? (
                supervisorId && specialistId ? (
                  (() => {
                    const roster = rosterByUser.get(m.userId);
                    const current =
                      roster?.roleId === supervisorId || roster?.roleId === specialistId
                        ? roster.roleId
                        : '';
                    return (
                      <select
                        value={current}
                        onChange={(e) => {
                          if (e.target.value) setTier(m.userId, e.target.value);
                        }}
                        className="rounded border px-1 py-0.5 text-xs bg-surface"
                        data-testid="unit-tier-select"
                      >
                        {!current && (
                          <option value="" disabled>
                            {roster?.roleName ?? '—'}
                          </option>
                        )}
                        <option value={supervisorId}>
                          {divisionRoles.find((r) => r.id === supervisorId)?.name}
                        </option>
                        <option value={specialistId}>
                          {divisionRoles.find((r) => r.id === specialistId)?.name}
                        </option>
                      </select>
                    );
                  })()
                ) : null
              ) : (
                <select
                  value={m.accessLevel}
                  className="rounded border px-1 py-0.5 text-xs bg-surface"
                  onChange={(e) => {
                    void groupsApi
                      .updateGroupMemberAccess(
                        teamId,
                        detail.id,
                        m.userId,
                        e.target.value as groupsApi.GroupAccessLevel,
                      )
                      .then(onInvalidate);
                  }}
                >
                  <option value="FULL">{t('groups.accessLevel.full')}</option>
                  <option value="READONLY">{t('groups.accessLevel.readonly')}</option>
                </select>
              )}
              <button
                type="button"
                className="text-danger underline"
                onClick={() => {
                  setMemberError(null);
                  void groupsApi.removeGroupMember(teamId, detail.id, m.userId).then(onInvalidate);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        {teamPickList.length > 0 && (
          <div className="mb-2">
            <p className="text-xs text-slate-500 mb-1">
              {isUnit ? t('units.addTeamMember') : t('groups.addTeamMember')}
            </p>
            <div className="flex flex-wrap gap-1">
              {teamPickList.map((m) => (
                <button
                  key={m.userId}
                  type="button"
                  className="text-xs border rounded px-2 py-0.5 hover:bg-bg-elevated"
                  onClick={() => addMember(m.userId)}
                >
                  + {m.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* v2.12: departments search ALL users — adding a non-member
            auto-joins them to the division server-side. COLLAB groups keep
            the invite semantics (out-of-division hits become invitations). */}
        <div>
            <p className="text-xs text-slate-500 mb-1">{t('groups.searchUsers')}</p>
            <input
              type="search"
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              placeholder={t('groups.searchUsersPlaceholder')}
              className="w-full rounded border px-2 py-1 text-xs bg-surface mb-1"
            />
            {!isUnit && (
              <select
                value={addAccess}
                onChange={(e) => setAddAccess(e.target.value as groupsApi.GroupAccessLevel)}
                className="rounded border px-1 py-0.5 text-xs bg-surface mb-1"
              >
                <option value="FULL">{t('groups.accessLevel.full')}</option>
                <option value="READONLY">{t('groups.accessLevel.readonly')}</option>
              </select>
            )}
            <ul className="max-h-24 overflow-y-auto space-y-1">
              {searchHits
                .filter((u) => !memberIds.has(u.id))
                .map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="text-xs w-full text-start hover:underline"
                      onClick={() => {
                        addMember(u.id);
                        setUserQuery('');
                      }}
                    >
                      {u.name} ({u.email})
                    </button>
                  </li>
                ))}
            </ul>
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-slate-500 mb-1">{t('groups.grantedProjects')}</p>
        <ul className="max-h-32 overflow-y-auto space-y-1">
          {projects.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={projectIds.has(p.id)}
                  onChange={(e) => {
                    setProjectIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      return next;
                    });
                  }}
                />
                <span>{p.name}</span>
              </label>
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={savePending}
          onClick={() => onSaveProjects([...projectIds])}
          className="mt-2 text-xs underline disabled:opacity-50"
        >
          {t('groups.saveProjects')}
        </button>
      </div>
    </div>
  );
}
