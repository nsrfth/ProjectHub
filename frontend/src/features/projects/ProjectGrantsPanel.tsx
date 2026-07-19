import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import * as grantsApi from '@/features/projects/grantsApi';
import * as groupsApi from '@/features/groups/api';
import Button from '@/features/ui/Button';

interface Props {
  teamId: string; // the project's HOME team
  projectId: string;
}

/**
 * v2.8 (Phases 2+3): THE sharing panel — one list for every subject a project
 * is shared with (teams, groups/units, individual users), replacing the
 * admin-only team-shares panel. Owner / ADMIN / project.share holders can use
 * it; consent boundaries surface as a PENDING chip until the responsible
 * manager accepts.
 */
export default function ProjectGrantsPanel({ teamId, projectId }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const { teams } = useTeams();
  const [error, setError] = useState<string | null>(null);
  const [subjectType, setSubjectType] = useState<'TEAM' | 'GROUP'>('TEAM');
  const [subjectId, setSubjectId] = useState('');
  const [level, setLevel] = useState<grantsApi.GrantLevel>('READ');

  const grantsKey = ['projects', projectId, 'grants'];
  const { data: grants = [], isLoading } = useQuery({
    queryKey: grantsKey,
    queryFn: () => grantsApi.listGrants(teamId, projectId),
  });
  // Home-team groups (units + collab) for the GROUP subject picker.
  const { data: groups = [] } = useQuery({
    queryKey: ['teams', teamId, 'groups'],
    queryFn: () => groupsApi.listGroups(teamId),
  });

  const invalidate = async () => {
    setError(null);
    await qc.invalidateQueries({ queryKey: grantsKey });
    await qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const createMut = useMutation({
    mutationFn: () =>
      grantsApi.createGrant(teamId, projectId, { subjectType, subjectId, level }),
    onSuccess: async () => {
      setSubjectId('');
      await invalidate();
    },
    onError: () => setError(t('grants.error')),
  });
  const revokeMut = useMutation({
    mutationFn: (grantId: string) => grantsApi.revokeGrant(teamId, projectId, grantId),
    onSuccess: invalidate,
    onError: () => setError(t('grants.error')),
  });

  const grantedKeys = new Set(grants.map((g) => `${g.subjectType}:${g.subjectId}`));
  const addableTeams = teams.filter(
    (tm) => tm.id !== teamId && !grantedKeys.has(`TEAM:${tm.id}`),
  );
  const addableGroups = groups.filter((g) => !grantedKeys.has(`GROUP:${g.id}`));

  const statusChip = (s: grantsApi.GrantStatus) =>
    s === 'ACTIVE' ? null : (
      <span
        className={
          'text-[10px] px-1.5 py-0.5 rounded border ' +
          (s === 'PENDING'
            ? 'border-amber-500 text-amber-600'
            : 'border-border text-text-muted line-through')
        }
      >
        {s === 'PENDING' ? t('grants.status.pending') : t('grants.status.declined')}
      </span>
    );

  return (
    <section className="border border-border rounded-md p-3 space-y-2" data-testid="project-grants-panel">
      <h3 className="text-sm font-semibold text-text">{t('grants.title')}</h3>
      <p className="text-xs text-text-muted">{t('grants.hint')}</p>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {isLoading ? (
        <p className="text-xs text-text-muted">…</p>
      ) : grants.length === 0 ? (
        <p className="text-xs text-text-muted">{t('grants.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center gap-2 text-sm" data-testid="grant-row">
              <span className="text-[10px] uppercase tracking-wide text-text-muted w-12 shrink-0">
                {t(`grants.subject.${g.subjectType.toLowerCase()}`)}
              </span>
              <span className="flex-1 truncate">{g.subjectName}</span>
              <span className="text-xs text-text-muted">
                {g.level === 'WRITE' ? t('grants.level.write') : t('grants.level.read')}
              </span>
              {statusChip(g.status)}
              <Button
                variant="ghost"
                size="sm"
                disabled={revokeMut.isPending}
                onClick={() => revokeMut.mutate(g.id)}
              >
                {t('grants.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={subjectType}
          onChange={(e) => {
            setSubjectType(e.target.value as 'TEAM' | 'GROUP');
            setSubjectId('');
          }}
          className="input w-auto py-1 text-xs"
          disabled={createMut.isPending}
        >
          <option value="TEAM">{t('grants.subject.team')}</option>
          <option value="GROUP">{t('grants.subject.group')}</option>
        </select>
        <select
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
          className="input flex-1 py-1 text-sm"
          disabled={createMut.isPending}
          data-testid="grant-subject-picker"
        >
          <option value="">{t('grants.pickSubject')}</option>
          {(subjectType === 'TEAM' ? addableTeams : addableGroups).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as grantsApi.GrantLevel)}
          className="input w-auto py-1 text-xs"
          disabled={createMut.isPending}
        >
          <option value="READ">{t('grants.level.read')}</option>
          <option value="WRITE">{t('grants.level.write')}</option>
        </select>
        <Button
          variant="secondary"
          size="sm"
          disabled={!subjectId || createMut.isPending}
          onClick={() => createMut.mutate()}
          data-testid="grant-add"
        >
          {t('grants.add')}
        </Button>
      </div>
    </section>
  );
}
