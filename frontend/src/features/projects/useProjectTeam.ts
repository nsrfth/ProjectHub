import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTeams } from '@/features/teams/TeamsContext';
import { listAllProjects, type ProjectCrossTeam } from './api';
import type { Team } from '@/features/teams/api';

// Resolve a project's owning team from the cross-team project list (v1.40).
// Project-scoped routes (/projects/:projectId/...) carry no :teamId in the
// URL, so pages must NOT rely on TeamsContext.currentTeam — the user may
// have navigated from the cross-team Projects list while another team is
// selected in the sidebar.
export function useProjectTeam(projectId: string | undefined): {
  teamId: string | null;
  project: ProjectCrossTeam | null;
  projectTeam: Team | null;
  loading: boolean;
} {
  const { teams } = useTeams();

  const { data: allProjects, isLoading } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: listAllProjects,
    enabled: !!projectId,
  });

  const project = useMemo(
    () => allProjects?.find((p) => p.id === projectId) ?? null,
    [allProjects, projectId],
  );
  const teamId = project?.teamId ?? null;
  const projectTeam = useMemo(
    () => teams.find((t) => t.id === teamId) ?? null,
    [teams, teamId],
  );

  // #region agent log
  if (projectId) {
    fetch('http://127.0.0.1:7913/ingest/ce89f6c8-255d-4008-a5cc-0cc6b19a3c80', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'adf9a1' },
      body: JSON.stringify({
        sessionId: 'adf9a1',
        hypothesisId: 'A',
        location: 'useProjectTeam.ts',
        message: 'project team resolution',
        data: {
          projectId,
          resolvedTeamId: teamId,
          projectFound: !!project,
          projectTeamName: projectTeam?.name ?? null,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  }
  // #endregion

  return { teamId, project, projectTeam, loading: isLoading };
}
