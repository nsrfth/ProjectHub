import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import * as projectsApi from '@/features/projects/api';
import Button from '@/features/ui/Button';

interface Props {
  teamId: string; // the project's HOME team
  projectId: string;
}

/**
 * v2.5.58: whole-team sharing manager — global ADMIN only (the parent modal
 * gates rendering; the API 403s anyone else). PUT is replace-set.
 */
export default function ProjectTeamSharesPanel({ teamId, projectId }: Props): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  // For a global ADMIN, TeamsContext.teams is the full team catalog
  // (teamsService.listMine returns every team for ADMIN).
  const { teams } = useTeams();
  const [error, setError] = useState<string | null>(null);

  const sharesKey = ['projects', projectId, 'team-shares'];
  const { data: shares = [], isLoading } = useQuery({
    queryKey: sharesKey,
    queryFn: () => projectsApi.listTeamShares(teamId, projectId),
  });

  const saveMut = useMutation({
    mutationFn: (next: Array<{ teamId: string; level: 'FULL' | 'READONLY' }>) =>
      projectsApi.setTeamShares(teamId, projectId, next),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: sharesKey });
      // Guest teams' project lists change with the share set.
      await qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: () => setError(t('projects.shares.error')),
  });

  const sharedTeamIds = new Set(shares.map((s) => s.teamId));
  const addableTeams = teams.filter((tm) => tm.id !== teamId && !sharedTeamIds.has(tm.id));
  const [pickTeamId, setPickTeamId] = useState('');

  function currentSet(): Array<{ teamId: string; level: 'FULL' | 'READONLY' }> {
    return shares.map((s) => ({ teamId: s.teamId, level: s.level }));
  }

  return (
    <section className="border border-border rounded-md p-3 space-y-2">
      <h3 className="text-sm font-semibold text-text">{t('projects.shares.title')}</h3>
      <p className="text-xs text-text-muted">{t('projects.shares.hint')}</p>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {isLoading ? (
        <p className="text-xs text-text-muted">…</p>
      ) : shares.length === 0 ? (
        <p className="text-xs text-text-muted">{t('projects.shares.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {shares.map((s) => (
            <li key={s.teamId} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate">{s.teamName}</span>
              <select
                value={s.level}
                onChange={(e) =>
                  saveMut.mutate(
                    currentSet().map((x) =>
                      x.teamId === s.teamId
                        ? { ...x, level: e.target.value as 'FULL' | 'READONLY' }
                        : x,
                    ),
                  )
                }
                className="input w-auto py-1 text-xs"
                disabled={saveMut.isPending}
              >
                <option value="READONLY">{t('projects.shares.level.readonly')}</option>
                <option value="FULL">{t('projects.shares.level.full')}</option>
              </select>
              <Button
                variant="ghost"
                size="sm"
                disabled={saveMut.isPending}
                onClick={() => saveMut.mutate(currentSet().filter((x) => x.teamId !== s.teamId))}
              >
                {t('projects.shares.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {addableTeams.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={pickTeamId}
            onChange={(e) => setPickTeamId(e.target.value)}
            className="input flex-1 py-1 text-sm"
            disabled={saveMut.isPending}
          >
            <option value="">{t('projects.shares.pickTeam')}</option>
            {addableTeams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={!pickTeamId || saveMut.isPending}
            onClick={() => {
              if (!pickTeamId) return;
              saveMut.mutate([...currentSet(), { teamId: pickTeamId, level: 'READONLY' }]);
              setPickTeamId('');
            }}
          >
            {t('projects.shares.add')}
          </Button>
        </div>
      )}
    </section>
  );
}
