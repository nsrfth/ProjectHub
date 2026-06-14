import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import * as customFieldsApi from '@/features/customFields/api';
import * as teamsApi from '@/features/teams/api';

const FIELD_TYPES: customFieldsApi.CustomFieldType[] = [
  'TEXT',
  'NUMBER',
  'DATE',
  'SINGLE_SELECT',
  'MULTI_SELECT',
  'CHECKBOX',
  'PERSON',
];

const SELECT_TYPES = new Set<customFieldsApi.CustomFieldType>(['SINGLE_SELECT', 'MULTI_SELECT']);

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

function typeLabel(t: (k: string) => string, type: customFieldsApi.CustomFieldType): string {
  const map: Record<customFieldsApi.CustomFieldType, string> = {
    TEXT: t('customfields.type.text'),
    NUMBER: t('customfields.type.number'),
    DATE: t('customfields.type.date'),
    SINGLE_SELECT: t('customfields.type.singleSelect'),
    MULTI_SELECT: t('customfields.type.multiSelect'),
    CHECKBOX: t('customfields.type.checkbox'),
    PERSON: t('customfields.type.person'),
  };
  return map[type];
}

export default function CustomFieldsPage(): JSX.Element {
  const { currentTeam } = useTeams();
  const t = useT();
  const qc = useQueryClient();
  const teamId = currentTeam?.id ?? null;

  const { data: teamDetail } = useQuery({
    queryKey: ['teams', teamId, 'detail'],
    queryFn: () => teamsApi.getTeam(teamId!),
    enabled: !!teamId,
  });

  const canManage = teamDetail?.capabilities.manageCustomFields ?? false;

  const { data: fields = [], isLoading } = useQuery({
    queryKey: ['customFields', teamId],
    queryFn: () => customFieldsApi.listCustomFields(teamId!),
    enabled: !!teamId && canManage,
  });

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<customFieldsApi.CustomFieldType>('TEXT');
  const [newRequired, setNewRequired] = useState(false);
  const [newOptions, setNewOptions] = useState('');

  const createMut = useMutation({
    mutationFn: () => {
      const options = newOptions
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((label, i) => ({ label, position: i }));
      return customFieldsApi.createCustomField(teamId!, {
        name: newName.trim(),
        type: newType,
        required: newRequired,
        options: SELECT_TYPES.has(newType) ? options : undefined,
      });
    },
    onSuccess: () => {
      setNewName('');
      setNewOptions('');
      qc.invalidateQueries({ queryKey: ['customFields', teamId] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not create field')),
  });

  const updateMut = useMutation({
    mutationFn: (input: { fieldId: string; patch: Parameters<typeof customFieldsApi.updateCustomField>[2] }) =>
      customFieldsApi.updateCustomField(teamId!, input.fieldId, input.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['customFields', teamId] }),
    onError: (err) => window.alert(errorMessage(err, 'Could not update field')),
  });

  const deleteMut = useMutation({
    mutationFn: (fieldId: string) => customFieldsApi.deleteCustomField(teamId!, fieldId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customFields', teamId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not delete field')),
  });

  if (!currentTeam) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('customfields.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('customfields.selectTeam')}</p>
      </section>
    );
  }

  if (!canManage) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('customfields.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('customfields.noAccess')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold mb-1">{t('customfields.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('customfields.subtitle').replace('{team}', currentTeam.name)}
        </p>
      </header>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}

      {!isLoading && fields.length === 0 && (
        <p className="text-sm text-slate-500 italic">{t('customfields.empty')}</p>
      )}

      {!isLoading && fields.length > 0 && (
        <ul className="divide-y divide-slate-200 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded">
          {fields.map((f) => (
            <FieldRow
              key={f.id}
              field={f}
              t={t}
              onToggleRequired={() => updateMut.mutate({ fieldId: f.id, patch: { required: !f.required } })}
              onToggleActive={() => updateMut.mutate({ fieldId: f.id, patch: { active: !f.active } })}
              onDelete={() => {
                if (window.confirm(t('customfields.deleteConfirm').replace('{name}', f.name))) {
                  deleteMut.mutate(f.id);
                }
              }}
              onSaveOptions={(options) =>
                customFieldsApi.setCustomFieldOptions(teamId!, f.id, options).then(() =>
                  qc.invalidateQueries({ queryKey: ['customFields', teamId] }),
                )
              }
            />
          ))}
        </ul>
      )}

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          createMut.mutate();
        }}
        className="border border-slate-200 dark:border-slate-700 rounded p-4 space-y-3"
      >
        <h3 className="font-medium text-sm">{t('customfields.create')}</h3>
        <div className="flex flex-wrap gap-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('customfields.name')}
            className="rounded border border-slate-300 px-2 py-1 text-sm flex-1 min-w-[160px]"
            required
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as customFieldsApi.CustomFieldType)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            {FIELD_TYPES.map((ft) => (
              <option key={ft} value={ft}>
                {typeLabel(t, ft)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={newRequired} onChange={(e) => setNewRequired(e.target.checked)} />
            {t('customfields.required')}
          </label>
        </div>
        {SELECT_TYPES.has(newType) && (
          <textarea
            value={newOptions}
            onChange={(e) => setNewOptions(e.target.value)}
            placeholder={`${t('customfields.options')} (one per line)`}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
            rows={3}
          />
        )}
        <button
          type="submit"
          disabled={createMut.isPending || !newName.trim()}
          className="bg-slate-900 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
        >
          {createMut.isPending ? '…' : t('customfields.create')}
        </button>
      </form>
    </section>
  );
}

function FieldRow({
  field,
  t,
  onToggleRequired,
  onToggleActive,
  onDelete,
  onSaveOptions,
}: {
  field: customFieldsApi.CustomFieldDefinition;
  t: (k: string) => string;
  onToggleRequired: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onSaveOptions: (options: Array<{ label: string; color?: string | null }>) => Promise<void>;
}): JSX.Element {
  const [optionText, setOptionText] = useState(field.options.map((o) => o.label).join('\n'));
  const [savingOpts, setSavingOpts] = useState(false);

  return (
    <li className="p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">{field.name}</span>
          <span className="ml-2 text-xs text-slate-500">{typeLabel(t, field.type)}</span>
          {field.required && (
            <span className="ml-2 text-xs bg-amber-100 text-amber-800 px-1 rounded">{t('customfields.required')}</span>
          )}
          {!field.active && (
            <span className="ml-2 text-xs bg-slate-200 text-slate-600 px-1 rounded">{t('customfields.inactive')}</span>
          )}
        </div>
        <div className="flex gap-2 text-xs">
          <button type="button" onClick={onToggleRequired} className="text-slate-600 hover:underline">
            {field.required ? `✓ ${t('customfields.required')}` : t('customfields.required')}
          </button>
          <button type="button" onClick={onToggleActive} className="text-slate-600 hover:underline">
            {field.active ? t('customfields.active') : t('customfields.inactive')}
          </button>
          <button type="button" onClick={onDelete} className="text-red-600 hover:underline">
            {t('customfields.delete')}
          </button>
        </div>
      </div>
      {SELECT_TYPES.has(field.type) && (
        <div className="space-y-1">
          <textarea
            value={optionText}
            onChange={(e) => setOptionText(e.target.value)}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
            rows={2}
          />
          <button
            type="button"
            disabled={savingOpts}
            onClick={async () => {
              setSavingOpts(true);
              try {
                const options = optionText
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .map((label, i) => ({ label, position: i }));
                await onSaveOptions(options);
              } finally {
                setSavingOpts(false);
              }
            }}
            className="text-xs text-slate-700 hover:underline"
          >
            {t('customfields.saveOptions')}
          </button>
        </div>
      )}
    </li>
  );
}
