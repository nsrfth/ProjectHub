import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as groupsApi from '@/features/groups/api';
import * as projectsApi from '@/features/projects/api';
import type { TeamMember } from '@/features/teams/api';
import { useT } from '@/lib/i18n';
import { visibleTeamMembers } from '@/lib/systemUser';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function TeamGroupsPanel({
  teamId,
  members,
}: {
  teamId: string;
  members: TeamMember[];
}): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const visibleMembers = visibleTeamMembers(members);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['groups', teamId],
    queryFn: () => groupsApi.listGroups(teamId),
  });

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

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['groups', teamId] });
    if (selectedId) await qc.invalidateQueries({ queryKey: ['groups', teamId, selectedId] });
  };

  const createMut = useMutation({
    mutationFn: () => groupsApi.createGroup(teamId, { name: newName.trim(), description: newDesc || null }),
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
      <h3 className="font-medium mb-2">{t('groups.title')}</h3>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">{t('groups.description')}</p>

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
          placeholder={t('groups.namePlaceholder')}
          className="rounded border px-2 py-1 text-sm dark:bg-slate-700 flex-1 min-w-[10rem]"
        />
        <input
          type="text"
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          placeholder={t('groups.descPlaceholder')}
          className="rounded border px-2 py-1 text-sm dark:bg-slate-700 flex-1 min-w-[10rem]"
        />
        <button
          type="submit"
          disabled={createMut.isPending || !newName.trim()}
          className="text-sm bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 disabled:opacity-50"
        >
          {t('groups.create')}
        </button>
      </form>
      {createError && <p className="text-xs text-red-600 mb-2">{createError}</p>}

      {isLoading && <p className="text-sm text-slate-500">{t('groups.loading')}</p>}
      {!isLoading && groups.length === 0 && (
        <p className="text-sm text-slate-500">{t('groups.empty')}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ul className="space-y-1 text-sm">
          {groups.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => setSelectedId(g.id)}
                className={`w-full text-left rounded px-2 py-1 ${
                  selectedId === g.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                {g.name}
                <span className="ml-2 text-xs opacity-70">
                  {g.memberCount} · {g.grantedProjectCount}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {selectedId && detail && !detailLoading && (
          <GroupEditor
            detail={detail}
            members={visibleMembers}
            projects={teamProjects}
            onDelete={() => {
              if (window.confirm(t('groups.confirmDelete'))) {
                deleteMut.mutate(selectedId);
              }
            }}
            onSaveMembers={async (ids) => {
              const current = new Set(detail.members.map((m) => m.userId));
              const desired = ids;
              const toAdd = desired.filter((id) => !current.has(id));
              const toRemove = [...current].filter((id) => !desired.includes(id));
              for (const uid of toRemove) {
                await groupsApi.removeGroupMember(teamId, selectedId, uid);
              }
              if (toAdd.length) await groupsApi.addGroupMembers(teamId, selectedId, toAdd);
              await invalidate();
            }}
            onSaveProjects={(ids) => setProjectsMut.mutate(ids)}
            deletePending={deleteMut.isPending}
            savePending={setProjectsMut.isPending}
          />
        )}
      </div>
    </section>
  );
}

function GroupEditor({
  detail,
  members,
  projects,
  onDelete,
  onSaveMembers,
  onSaveProjects,
  deletePending,
  savePending,
}: {
  detail: groupsApi.UserGroupDetail;
  members: TeamMember[];
  projects: projectsApi.Project[];
  onDelete: () => void;
  onSaveMembers: (userIds: string[]) => Promise<void>;
  onSaveProjects: (projectIds: string[]) => void;
  deletePending: boolean;
  savePending: boolean;
}): JSX.Element {
  const t = useT();
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [projectIds, setProjectIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setMemberIds(new Set(detail.members.map((m) => m.userId)));
    setProjectIds(new Set(detail.projects.map((p) => p.projectId)));
  }, [detail.id, detail.members, detail.projects]);

  return (
    <div className="border rounded p-3 text-sm space-y-3 dark:border-slate-600">
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
          className="text-xs text-red-600 hover:underline disabled:opacity-50"
        >
          {t('groups.delete')}
        </button>
      </div>

      <div>
        <p className="text-xs font-medium text-slate-500 mb-1">{t('groups.members')}</p>
        <ul className="max-h-32 overflow-y-auto space-y-1">
          {members.map((m) => (
            <li key={m.userId}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={memberIds.has(m.userId)}
                  onChange={(e) => {
                    setMemberIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m.userId);
                      else next.delete(m.userId);
                      return next;
                    });
                  }}
                />
                <span>{m.name}</span>
                <span className="text-xs text-slate-400">{m.email}</span>
              </label>
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={savePending}
          onClick={() => void onSaveMembers([...memberIds])}
          className="mt-2 text-xs underline disabled:opacity-50"
        >
          {t('groups.saveMembers')}
        </button>
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
