import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import * as teamsApi from '@/features/teams/api';
import * as formsApi from '@/features/forms/api';

export default function FormsListPage(): JSX.Element {
  const { currentTeam } = useTeams();
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const teamId = currentTeam?.id ?? null;

  const { data: teamDetail } = useQuery({
    queryKey: ['teams', teamId, 'detail'],
    queryFn: () => teamsApi.getTeam(teamId!),
    enabled: !!teamId,
  });

  const canManage = teamDetail?.capabilities.manageForms ?? false;

  const { data: forms = [], isLoading } = useQuery({
    queryKey: ['forms', teamId],
    queryFn: () => formsApi.listForms(teamId!),
    enabled: !!teamId,
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const projects = await import('@/features/projects/api').then((m) => m.listProjects(teamId!));
      const projectId = projects[0]?.id;
      if (!projectId) throw new Error(t('forms.noProject'));
      return formsApi.createForm(teamId!, {
        projectId,
        name: t('forms.defaultName'),
        fields: [{ label: t('forms.field.titleDefault'), target: 'title', required: true, position: 0 }],
      });
    },
    onSuccess: (form) => {
      qc.invalidateQueries({ queryKey: ['forms', teamId] });
      nav(`/settings/forms/${form.id}`);
    },
  });

  if (!teamId) {
    return <p className="text-slate-500">{t('teams.selectTeam')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('forms.title')}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('forms.listDesc')}</p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t('forms.create')}
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-slate-500">{t('common.loading')}</p>
      ) : forms.length === 0 ? (
        <p className="text-slate-500">{t('forms.empty')}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {forms.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{f.name}</p>
                <p className="text-xs text-slate-500">
                  {f.mode === 'PUBLIC' ? t('forms.mode.public') : t('forms.mode.team')}
                  {!f.enabled && ` · ${t('forms.disabled')}`}
                </p>
              </div>
              <div className="flex gap-2">
                {f.enabled && (
                  <Link
                    to={`/forms/${f.id}`}
                    className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {t('forms.openSubmit')}
                  </Link>
                )}
                {canManage && (
                  <Link
                    to={`/settings/forms/${f.id}`}
                    className="text-sm text-slate-600 hover:underline dark:text-slate-300"
                  >
                    {t('forms.edit')}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
