import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as customFieldsApi from '@/features/customFields/api';
import type { TaskCustomFieldValue } from '@/features/customFields/api';
import type { TeamMember } from '@/features/teams/api';
import { useT } from '@/lib/i18n';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

function displayValue(cf: TaskCustomFieldValue, t: (k: string) => string): string {
  switch (cf.fieldType) {
    case 'TEXT':
      return cf.valueText ?? t('customfields.none');
    case 'NUMBER':
      return cf.valueNumber ?? t('customfields.none');
    case 'DATE':
      return cf.valueDate ? cf.valueDate.slice(0, 10) : t('customfields.none');
    case 'CHECKBOX':
      return cf.valueBool === null ? t('customfields.none') : cf.valueBool ? '✓' : '✗';
    case 'PERSON':
      return cf.valueUserName ?? t('customfields.none');
    case 'SINGLE_SELECT':
    case 'MULTI_SELECT':
      return cf.optionLabels.length ? cf.optionLabels.join(', ') : t('customfields.none');
    default:
      return t('customfields.none');
  }
}

export function TaskCustomFieldsSection({
  teamId,
  projectId,
  taskId,
  customFields,
  canEdit,
  teamMembers,
}: {
  teamId: string;
  projectId: string;
  taskId: string;
  customFields: TaskCustomFieldValue[];
  canEdit: boolean;
  teamMembers: TeamMember[];
}): JSX.Element | null {
  const t = useT();
  const qc = useQueryClient();

  const { data: definitions = [] } = useQuery({
    queryKey: ['customFields', teamId],
    queryFn: () => customFieldsApi.listCustomFields(teamId),
  });

  const activeFields = customFields.filter((cf) => cf.active);
  if (activeFields.length === 0 && definitions.filter((d) => d.active).length === 0) {
    return null;
  }

  const setMut = useMutation({
    mutationFn: (input: { fieldId: string; body: Parameters<typeof customFieldsApi.setTaskCustomFieldValue>[4] }) =>
      customFieldsApi.setTaskCustomFieldValue(teamId, projectId, taskId, input.fieldId, input.body),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['task', teamId, projectId, taskId] }),
        qc.invalidateQueries({ queryKey: ['tasks', teamId, projectId] }),
        qc.invalidateQueries({ queryKey: ['activity', taskId] }),
      ]);
    },
    onError: (err) => window.alert(errorMessage(err, 'Could not save custom field')),
  });

  const fieldsToShow = definitions.filter((d) => d.active).map((def) => {
    const val = customFields.find((cf) => cf.fieldId === def.id);
    return { def, val };
  });

  return (
    <section className="bg-white rounded shadow p-6 mb-6">
      <h2 className="font-medium mb-3">{t('customfields.onTask')}</h2>
      <ul className="space-y-4">
        {fieldsToShow.map(({ def, val }) => (
          <FieldEditor
            key={def.id}
            definition={def}
            value={val}
            canEdit={canEdit}
            teamMembers={teamMembers}
            pending={setMut.isPending}
            t={t}
            onSave={(body) => setMut.mutate({ fieldId: def.id, body })}
          />
        ))}
      </ul>
    </section>
  );
}

function FieldEditor({
  definition,
  value,
  canEdit,
  teamMembers,
  pending,
  t,
  onSave,
}: {
  definition: customFieldsApi.CustomFieldDefinition;
  value: TaskCustomFieldValue | undefined;
  canEdit: boolean;
  teamMembers: TeamMember[];
  pending: boolean;
  t: (k: string) => string;
  onSave: (body: Parameters<typeof customFieldsApi.setTaskCustomFieldValue>[4]) => void;
}): JSX.Element {
  const cf: TaskCustomFieldValue = value ?? {
    fieldId: definition.id,
    fieldName: definition.name,
    fieldType: definition.type,
    required: definition.required,
    active: definition.active,
    valueText: null,
    valueNumber: null,
    valueDate: null,
    valueBool: null,
    valueUserId: null,
    valueUserName: null,
    optionIds: [],
    optionLabels: [],
  };

  if (!canEdit) {
    return (
      <li className="text-sm">
        <span className="font-medium text-slate-700">{cf.fieldName}</span>
        {cf.required && <span className="text-red-500 ml-1">*</span>}
        <span className="ml-2 text-slate-600">{displayValue(cf, t)}</span>
      </li>
    );
  }

  return (
    <li className="text-sm space-y-1">
      <label className="font-medium text-slate-700 block">
        {cf.fieldName}
        {cf.required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <EditableInput
        definition={definition}
        value={cf}
        teamMembers={teamMembers}
        pending={pending}
        t={t}
        onSave={onSave}
      />
    </li>
  );
}

function EditableInput({
  definition,
  value,
  teamMembers,
  pending,
  t,
  onSave,
}: {
  definition: customFieldsApi.CustomFieldDefinition;
  value: TaskCustomFieldValue;
  teamMembers: TeamMember[];
  pending: boolean;
  t: (k: string) => string;
  onSave: (body: Parameters<typeof customFieldsApi.setTaskCustomFieldValue>[4]) => void;
}): JSX.Element {
  const [text, setText] = useState(value.valueText ?? '');
  const [num, setNum] = useState(value.valueNumber ?? '');
  const [date, setDate] = useState(value.valueDate?.slice(0, 10) ?? '');
  const [checked, setChecked] = useState(value.valueBool ?? false);
  const [userId, setUserId] = useState(value.valueUserId ?? '');
  const [optionIds, setOptionIds] = useState<string[]>(value.optionIds);

  useEffect(() => {
    setText(value.valueText ?? '');
    setNum(value.valueNumber ?? '');
    setDate(value.valueDate?.slice(0, 10) ?? '');
    setChecked(value.valueBool ?? false);
    setUserId(value.valueUserId ?? '');
    setOptionIds(value.optionIds);
  }, [value]);

  const hasValue =
    value.valueText !== null ||
    value.valueNumber !== null ||
    value.valueDate !== null ||
    value.valueBool !== null ||
    value.valueUserId !== null ||
    value.optionIds.length > 0;

  function savePayload(): Parameters<typeof customFieldsApi.setTaskCustomFieldValue>[4] {
    switch (definition.type) {
      case 'TEXT':
        return { valueText: text.trim() || null };
      case 'NUMBER':
        return { valueNumber: num.trim() || null };
      case 'DATE':
        return { valueDate: date ? `${date}T00:00:00.000Z` : null };
      case 'CHECKBOX':
        return { valueBool: checked };
      case 'PERSON':
        return { valueUserId: userId || null };
      case 'SINGLE_SELECT':
        return { optionIds: optionIds.slice(0, 1) };
      case 'MULTI_SELECT':
        return { optionIds };
      default:
        return {};
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {definition.type === 'TEXT' && (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 flex-1 min-w-[200px]"
        />
      )}
      {definition.type === 'NUMBER' && (
        <input
          type="text"
          inputMode="decimal"
          value={num}
          onChange={(e) => setNum(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 w-32"
        />
      )}
      {definition.type === 'DATE' && (
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1"
        />
      )}
      {definition.type === 'CHECKBOX' && (
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
      )}
      {definition.type === 'PERSON' && (
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1"
        >
          <option value="">{t('customfields.pickPerson')}</option>
          {teamMembers.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
      )}
      {definition.type === 'SINGLE_SELECT' && (
        <select
          value={optionIds[0] ?? ''}
          onChange={(e) => setOptionIds(e.target.value ? [e.target.value] : [])}
          className="rounded border border-slate-300 px-2 py-1"
        >
          <option value="">{t('customfields.none')}</option>
          {definition.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {definition.type === 'MULTI_SELECT' && (
        <div className="flex flex-wrap gap-2">
          {definition.options.map((o) => (
            <label key={o.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={optionIds.includes(o.id)}
                onChange={(e) => {
                  setOptionIds((prev) =>
                    e.target.checked ? [...prev, o.id] : prev.filter((id) => id !== o.id),
                  );
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => onSave(savePayload())}
        className="text-xs bg-slate-900 text-white rounded px-2 py-1 disabled:opacity-50"
      >
        {t('customfields.save')}
      </button>
      {hasValue && (
        <button
          type="button"
          disabled={pending}
          onClick={() => onSave({ clear: true })}
          className="text-xs text-slate-500 hover:underline"
        >
          {t('customfields.clear')}
        </button>
      )}
    </div>
  );
}
