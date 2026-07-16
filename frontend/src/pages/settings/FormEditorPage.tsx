import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import * as teamsApi from '@/features/teams/api';
import * as projectsApi from '@/features/projects/api';
import * as customFieldsApi from '@/features/customFields/api';
import * as formsApi from '@/features/forms/api';
import type { IntakeFormFieldInput, IntakeFormFieldTarget } from '@/features/forms/api';

const BUILTIN_TARGETS: IntakeFormFieldTarget[] = [
  'title',
  'description',
  'priority',
  'dueDate',
  'assignee',
  'labels',
];

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function FormEditorPage(): JSX.Element {
  const { formId } = useParams<{ formId: string }>();
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

  const { data: form, isLoading } = useQuery({
    queryKey: ['forms', teamId, formId],
    queryFn: () => formsApi.getForm(teamId!, formId!),
    enabled: !!teamId && !!formId && canManage,
  });

  const { data: projects = [] } = useQuery({
    queryKey: ['projects', teamId],
    queryFn: () => projectsApi.listProjects(teamId!),
    enabled: !!teamId && canManage,
  });

  const { data: customFields = [] } = useQuery({
    queryKey: ['customFields', teamId],
    queryFn: () => customFieldsApi.listCustomFields(teamId!),
    enabled: !!teamId && canManage,
  });

  const [draft, setDraft] = useState<{
    name: string;
    description: string;
    projectId: string;
    mode: 'TEAM' | 'PUBLIC';
    enabled: boolean;
    fields: IntakeFormFieldInput[];
  } | null>(null);

  const working = draft ?? (form ? {
    name: form.name,
    description: form.description ?? '',
    projectId: form.projectId,
    mode: form.mode,
    enabled: form.enabled,
    fields: form.fields.map((f) => ({
      label: f.label,
      target: f.target,
      customFieldId: f.customFieldId,
      required: f.required,
      helpText: f.helpText,
      position: f.position,
    })),
  } : null);

  const saveMut = useMutation({
    mutationFn: () =>
      formsApi.updateForm(teamId!, formId!, {
        name: working!.name.trim(),
        description: working!.description.trim() || null,
        projectId: working!.projectId,
        mode: working!.mode,
        enabled: working!.enabled,
        fields: working!.fields.map((f, i) => ({ ...f, position: i })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['forms', teamId] });
      setDraft(null);
    },
    onError: (err) => window.alert(errorMessage(err, t('forms.saveError'))),
  });

  const rotateMut = useMutation({
    mutationFn: () => formsApi.rotateFormToken(teamId!, formId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['forms', teamId, formId] }),
    onError: (err) => window.alert(errorMessage(err, t('forms.rotateError'))),
  });

  const deleteMut = useMutation({
    mutationFn: () => formsApi.deleteForm(teamId!, formId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['forms', teamId] });
      nav('/settings/forms');
    },
  });

  const publicUrl = useMemo(() => {
    if (!form?.publicToken) return null;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/public/forms/${form.publicToken}`;
  }, [form?.publicToken]);

  if (!canManage) {
    return <p className="text-slate-500">{t('forms.noPermission')}</p>;
  }
  if (isLoading || !working) {
    return <p className="text-slate-500">{t('common.loading')}</p>;
  }

  function patch(partial: Partial<typeof working>) {
    setDraft({ ...working!, ...partial });
  }

  function addField() {
    patch({
      fields: [
        ...working!.fields,
        { label: t('forms.field.new'), target: 'description', required: false, position: working!.fields.length },
      ],
    });
  }

  function updateField(index: number, partial: Partial<IntakeFormFieldInput>) {
    const fields = [...working!.fields];
    fields[index] = { ...fields[index]!, ...partial };
    patch({ fields });
  }

  function removeField(index: number) {
    patch({ fields: working!.fields.filter((_, i) => i !== index) });
  }

  function moveField(index: number, dir: -1 | 1) {
    const fields = [...working!.fields];
    const next = index + dir;
    if (next < 0 || next >= fields.length) return;
    [fields[index], fields[next]] = [fields[next]!, fields[index]!];
    patch({ fields });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/settings/forms" className="text-blue-600 hover:underline dark:text-blue-400">
          {t('forms.title')}
        </Link>
        <span className="text-slate-400">/</span>
        <span className="text-text">{working.name}</span>
      </div>

      <div className="space-y-4 rounded-lg border border-border p-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('forms.name')}</span>
          <input
            className="w-full rounded-md border border-border px-3 py-2 text-sm dark:bg-slate-900"
            value={working.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('forms.description')}</span>
          <textarea
            rows={2}
            className="w-full rounded-md border border-border px-3 py-2 text-sm dark:bg-slate-900"
            value={working.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('forms.project')}</span>
          <select
            className="w-full rounded-md border border-border px-3 py-2 text-sm dark:bg-slate-900"
            value={working.projectId}
            onChange={(e) => patch({ projectId: e.target.value })}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('forms.mode.label')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={working.mode === 'TEAM'}
              onChange={() => patch({ mode: 'TEAM' })}
            />
            {t('forms.mode.team')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={working.mode === 'PUBLIC'}
              onChange={() => patch({ mode: 'PUBLIC' })}
            />
            {t('forms.mode.public')}
          </label>
          {working.mode === 'PUBLIC' && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-warning dark:border-amber-900 dark:bg-amber-950">
              {t('forms.publicWarning')}
            </p>
          )}
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={working.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          {t('forms.enabled')}
        </label>

        {working.mode === 'PUBLIC' && publicUrl && (
          <div className="space-y-2 rounded-md bg-bg p-3 text-sm">
            <p className="font-medium">{t('forms.publicUrl')}</p>
            <code className="block break-all text-xs" dir="ltr">
              {publicUrl}
            </code>
            <button
              type="button"
              onClick={() => rotateMut.mutate()}
              disabled={rotateMut.isPending}
              className="text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              {t('forms.rotateToken')}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">{t('forms.fields')}</h2>
        {working.fields.map((field, index) => (
          <div
            key={index}
            className="space-y-2 rounded-lg border border-border p-3"
          >
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => moveField(index, -1)} disabled={index === 0}>
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveField(index, 1)}
                disabled={index === working.fields.length - 1}
              >
                ↓
              </button>
              <button type="button" onClick={() => removeField(index)} className="text-danger">
                {t('common.delete')}
              </button>
            </div>
            <input
              className="w-full rounded-md border border-border px-2 py-1 text-sm dark:bg-slate-900"
              value={field.label}
              onChange={(e) => updateField(index, { label: e.target.value })}
              placeholder={t('forms.field.label')}
            />
            <select
              className="w-full rounded-md border border-border px-2 py-1 text-sm dark:bg-slate-900"
              value={field.target === 'customField' ? 'customField' : field.target}
              onChange={(e) => {
                const target = e.target.value as IntakeFormFieldTarget;
                updateField(index, {
                  target,
                  customFieldId: target === 'customField' ? customFields[0]?.id ?? null : null,
                });
              }}
            >
              {BUILTIN_TARGETS.filter((bt) => working.mode === 'TEAM' || bt !== 'assignee').map((bt) => (
                <option key={bt} value={bt}>
                  {t(`forms.field.target.${bt}`)}
                </option>
              ))}
              <option value="customField">{t('forms.field.target.customField')}</option>
            </select>
            {field.target === 'customField' && (
              <select
                className="w-full rounded-md border border-border px-2 py-1 text-sm dark:bg-slate-900"
                value={field.customFieldId ?? ''}
                onChange={(e) => updateField(index, { customFieldId: e.target.value })}
              >
                {customFields
                  .filter((cf) => working.mode === 'TEAM' || cf.type !== 'PERSON')
                  .map((cf) => (
                    <option key={cf.id} value={cf.id}>
                      {cf.name} ({cf.type})
                    </option>
                  ))}
              </select>
            )}
            <input
              className="w-full rounded-md border border-border px-2 py-1 text-sm dark:bg-slate-900"
              value={field.helpText ?? ''}
              onChange={(e) => updateField(index, { helpText: e.target.value || null })}
              placeholder={t('forms.field.helpText')}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={field.required ?? false}
                onChange={(e) => updateField(index, { required: e.target.checked })}
              />
              {t('forms.field.required')}
            </label>
          </div>
        ))}
        <button type="button" onClick={addField} className="text-sm text-blue-600 dark:text-blue-400">
          + {t('forms.addField')}
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
        >
          {t('common.save')}
        </button>
        <Link
          to={`/forms/${formId}`}
          className="rounded-md border border-border px-4 py-2 text-sm"
        >
          {t('forms.previewSubmit')}
        </Link>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t('forms.confirmDelete'))) deleteMut.mutate();
          }}
          className="text-sm text-danger"
        >
          {t('common.delete')}
        </button>
      </div>
    </div>
  );
}
