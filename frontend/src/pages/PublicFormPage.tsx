import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useT } from '@/lib/i18n';
import * as formsApi from '@/features/forms/api';
import FormRenderer from '@/features/forms/FormRenderer';

/** Standalone public intake form — no app chrome, no auth, minimal data exposure. */
export default function PublicFormPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const t = useT();
  const [submitted, setSubmitted] = useState(false);

  const { data: form, isLoading, isError } = useQuery({
    queryKey: ['publicForm', token],
    queryFn: () => formsApi.fetchPublicForm(token!),
    enabled: !!token,
    retry: false,
  });

  const submitMut = useMutation({
    mutationFn: ({ values, website }: { values: Record<string, unknown>; website: string }) =>
      formsApi.submitPublicForm(token!, values, website),
    onSuccess: () => setSubmitted(true),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <p className="text-slate-500">{t('common.loading')}</p>
      </div>
    );
  }

  if (isError || !form) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <p className="text-slate-600 dark:text-slate-400">{t('forms.notFound')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <header className="mb-6 border-b border-slate-100 pb-4 dark:border-slate-800">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{form.name}</h1>
          {form.description && (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{form.description}</p>
          )}
        </header>
        <FormRenderer
          fields={form.fields}
          submitted={submitted}
          submitting={submitMut.isPending}
          onSubmit={async (values, website) => {
            await submitMut.mutateAsync({ values, website });
          }}
        />
      </div>
    </div>
  );
}
