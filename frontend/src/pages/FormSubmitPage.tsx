import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import * as teamsApi from '@/features/teams/api';
import * as formsApi from '@/features/forms/api';
import FormRenderer from '@/features/forms/FormRenderer';

export default function FormSubmitPage(): JSX.Element {
  const { formId } = useParams<{ formId: string }>();
  const { currentTeam } = useTeams();
  const t = useT();
  const teamId = currentTeam?.id ?? null;
  const [submitted, setSubmitted] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);

  const { data: teamDetail } = useQuery({
    queryKey: ['teams', teamId, 'detail'],
    queryFn: () => teamsApi.getTeam(teamId!),
    enabled: !!teamId,
  });

  const { data: form, isLoading } = useQuery({
    queryKey: ['forms', teamId, formId],
    queryFn: () => formsApi.getForm(teamId!, formId!),
    enabled: !!teamId && !!formId,
  });

  const submitMut = useMutation({
    mutationFn: (values: Record<string, unknown>) => formsApi.submitForm(teamId!, formId!, values),
    onSuccess: (res) => {
      setTaskId(res.taskId);
      setSubmitted(true);
    },
  });

  const members =
    teamDetail?.members
      .filter((m) => !m.external)
      .map((m) => ({ userId: m.userId, name: m.name })) ?? [];

  if (!teamId) return <p className="text-slate-500">{t('teams.selectTeam')}</p>;
  if (isLoading || !form) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (!form.enabled) return <p className="text-slate-500">{t('forms.disabled')}</p>;

  return (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-8">
      <div>
        <Link to="/settings/forms" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          ← {t('forms.title')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">{form.name}</h1>
        {form.description && (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{form.description}</p>
        )}
      </div>

      {submitted && taskId ? (
        <div className="space-y-3">
          <p className="text-emerald-700 dark:text-emerald-300">{t('forms.submitted')}</p>
          <Link
            to={`/projects/${form.projectId}/tasks/${taskId}`}
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            {t('forms.viewTask')}
          </Link>
        </div>
      ) : (
        <FormRenderer
          fields={form.fields}
          members={members}
          submitting={submitMut.isPending}
          onSubmit={async (values) => {
            await submitMut.mutateAsync(values);
          }}
        />
      )}
    </div>
  );
}
