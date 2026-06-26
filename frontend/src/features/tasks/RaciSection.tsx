import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import { listTeamMembersForAssignees } from '@/features/teams/api';
import { listTaskRaci, putTaskRaci, type RaciEntry, type RaciRole } from './api';

interface RaciSectionProps {
  teamId: string;
  projectId: string;
  taskId: string;
  canWrite: boolean;
}

const ROLES: RaciRole[] = ['CONSULTED', 'INFORMED'];

export default function RaciSection({
  teamId,
  projectId,
  taskId,
  canWrite,
}: RaciSectionProps): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [addRole, setAddRole] = useState<RaciRole>('CONSULTED');
  const [addUserId, setAddUserId] = useState('');

  const raciKey = ['tasks', taskId, 'raci'];

  const { data: entries = [] } = useQuery({
    queryKey: raciKey,
    queryFn: () => listTaskRaci(teamId, projectId, taskId),
  });

  const { data: membersRaw = [] } = useQuery({
    queryKey: ['teams', teamId, 'assignees'],
    queryFn: () => listTeamMembersForAssignees(teamId),
    staleTime: 30_000,
    enabled: canWrite,
  });

  const putMut = useMutation({
    mutationFn: (next: RaciEntry[]) =>
      putTaskRaci(
        teamId,
        projectId,
        taskId,
        next.map(({ userId, role }) => ({ userId, role })),
      ),
    onSuccess: (updated) => {
      qc.setQueryData(raciKey, updated);
    },
  });

  function addEntry(): void {
    if (!addUserId) return;
    const next = [...entries.filter((e) => !(e.userId === addUserId && e.role === addRole)),
      { userId: addUserId, userName: membersRaw.find((m) => m.userId === addUserId)?.name ?? addUserId, role: addRole }];
    putMut.mutate(next);
    setAddUserId('');
  }

  function removeEntry(userId: string, role: RaciRole): void {
    putMut.mutate(entries.filter((e) => !(e.userId === userId && e.role === role)));
  }

  const consulted = entries.filter((e) => e.role === 'CONSULTED');
  const informed = entries.filter((e) => e.role === 'INFORMED');

  function RoleGroup({ role, list }: { role: RaciRole; list: RaciEntry[] }): JSX.Element {
    return (
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-1">
          {t(`tasks.raci.${role.toLowerCase()}` as never)} ({t(`tasks.raci.${role.toLowerCase()}Abbr` as never)})
        </h4>
        {list.length === 0 ? (
          <p className="text-xs text-text-muted italic">{t('tasks.raci.none')}</p>
        ) : (
          <ul className="space-y-0.5">
            {list.map((e) => (
              <li key={`${e.userId}-${e.role}`} className="flex items-center justify-between gap-2 text-sm">
                <span>{e.userName}</span>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => removeEntry(e.userId, e.role)}
                    disabled={putMut.isPending}
                    className="text-xs text-danger hover:underline"
                    aria-label={t('tasks.raci.remove')}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t('tasks.raci.title')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <RoleGroup role="CONSULTED" list={consulted} />
        <RoleGroup role="INFORMED" list={informed} />
      </div>
      {canWrite && (
        <div className="flex gap-2 flex-wrap">
          <select
            value={addRole}
            onChange={(e) => setAddRole(e.target.value as RaciRole)}
            className="rounded border px-2 py-1 text-sm dark:bg-slate-700"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`tasks.raci.${r.toLowerCase()}` as never)}
              </option>
            ))}
          </select>
          <select
            value={addUserId}
            onChange={(e) => setAddUserId(e.target.value)}
            className="rounded border px-2 py-1 text-sm dark:bg-slate-700 flex-1 min-w-0"
          >
            <option value="">{t('tasks.raci.selectMember')}</option>
            {membersRaw.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addEntry}
            disabled={!addUserId || putMut.isPending}
            className="px-3 py-1 text-sm rounded bg-primary text-primary-contrast disabled:opacity-50"
          >
            {t('tasks.raci.add')}
          </button>
        </div>
      )}
    </section>
  );
}
