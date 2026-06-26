import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useProjectTeam } from '@/features/projects/useProjectTeam';
import { getMyDelegateStatus } from '@/features/projects/api';
import { useAuth } from '@/features/auth/AuthContext';
import { EvmDashboard } from '@/features/evm/EvmDashboard';
import { useT } from '@/lib/i18n';

interface RouteParams extends Record<string, string | undefined> {
  projectId: string;
}

// v2.3 (PMIS R7): per-project earned value management dashboard.
export default function ProjectEvmPage(): JSX.Element {
  const { projectId } = useParams<RouteParams>();
  const t = useT();
  const { user } = useAuth();
  const { teamId, project, projectTeam, loading } = useProjectTeam(projectId);

  const { data: delegate } = useQuery({
    queryKey: ['projects', teamId, projectId, 'delegate', 'me'],
    queryFn: () => getMyDelegateStatus(teamId!, projectId!),
    enabled: !!teamId && !!projectId,
  });

  if (loading) {
    return <div className="p-8 text-sm text-text-muted">{t('common.loading')}</div>;
  }

  if (!teamId || !project) {
    return (
      <div className="p-8">
        <Link to="/projects" className="text-sm underline">← {t('nav.projects')}</Link>
        <p className="mt-4 text-sm text-slate-500">{t('evm.notFound')}</p>
      </div>
    );
  }

  const isManager = projectTeam?.myRole === 'MANAGER';
  const isAdmin = user?.globalRole === 'ADMIN';
  const isOwner = project.ownerId === user?.id;
  const canManage = isAdmin || isManager || isOwner || (delegate?.isDelegate ?? false);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6 gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold truncate">{t('evm.title')}</h1>
          <p className="text-sm text-slate-500">
            {project.name}
            {project.teamName ? <>{' · '}<span className="font-medium">{project.teamName}</span></> : null}
          </p>
        </div>
        <Link to="/projects" className="text-sm underline whitespace-nowrap">← {t('nav.projects')}</Link>
      </div>

      <section className="bg-surface rounded shadow p-6">
        <EvmDashboard teamId={teamId} projectId={projectId!} canManage={canManage} />
      </section>
    </div>
  );
}
