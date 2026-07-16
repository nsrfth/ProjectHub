import { useState, type FormEvent } from 'react';
import { useT } from '@/lib/i18n';
import type { IntakeFormField } from './api';

interface Props {
  fields: IntakeFormField[];
  onSubmit: (values: Record<string, unknown>, website: string) => Promise<void>;
  members?: { userId: string; name: string }[];
  submitting?: boolean;
  submitted?: boolean;
}

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export default function FormRenderer({
  fields,
  onSubmit,
  members,
  submitting,
  submitted,
}: Props): JSX.Element {
  const t = useT();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [website, setWebsite] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sorted = [...fields].sort((a, b) => a.position - b.position);

  function setField(id: string, value: unknown) {
    setValues((prev) => ({ ...prev, [id]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await onSubmit(values, website);
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error
              ?.message
          : null;
      setError(msg ?? t('forms.submitError'));
    }
  }

  if (submitted) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-center dark:border-emerald-900 dark:bg-emerald-950">
        <p className="text-lg font-medium text-success">{t('forms.submitted')}</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Honeypot — hidden from humans, visible to bots */}
      <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
        <label htmlFor="website">{t('forms.honeypot')}</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      {sorted.map((field) => (
        <div key={field.id} className="space-y-1">
          <label htmlFor={field.id} className="block text-sm font-medium text-text">
            {field.label}
            {field.required && <span className="text-danger"> *</span>}
          </label>
          {field.helpText && (
            <p className="text-xs text-text-muted">{field.helpText}</p>
          )}
          {renderInput(field, values[field.id], (v) => setField(field.id, v), members, t)}
        </div>
      ))}

      {error && <p className="text-sm text-danger" role="alert">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
      >
        {submitting ? t('forms.submitting') : t('forms.submit')}
      </button>
    </form>
  );
}

function renderInput(
  field: IntakeFormField,
  value: unknown,
  onChange: (v: unknown) => void,
  members: Props['members'],
  t: (k: string) => string,
): JSX.Element {
  const id = field.id;
  const common =
    'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm';

  if (field.target === 'title' || field.target === 'description') {
    const isArea = field.target === 'description';
    if (isArea) {
      return (
        <textarea
          id={id}
          required={field.required}
          rows={4}
          className={common}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    return (
      <input
        id={id}
        type="text"
        required={field.required}
        className={common}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (field.target === 'priority') {
    return (
      <select
        id={id}
        required={field.required}
        className={common}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('forms.field.priorityPlaceholder')}</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {t(`forms.field.priority.${p.toLowerCase()}`)}
          </option>
        ))}
      </select>
    );
  }

  if (field.target === 'dueDate') {
    return (
      <input
        id={id}
        type="date"
        required={field.required}
        className={common}
        dir="ltr"
        value={(value as string)?.slice(0, 10) ?? ''}
        onChange={(e) => onChange(e.target.value ? `${e.target.value}T00:00:00.000Z` : '')}
      />
    );
  }

  if (field.target === 'assignee' && members) {
    return (
      <select
        id={id}
        required={field.required}
        className={common}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{t('forms.field.assigneePlaceholder')}</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>
    );
  }

  if (field.target === 'labels' && field.options) {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex flex-wrap gap-2">
        {field.options.map((opt) => {
          const checked = selected.includes(opt.id);
          return (
            <label key={opt.id} className="inline-flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => {
                  onChange(checked ? selected.filter((x) => x !== opt.id) : [...selected, opt.id]);
                }}
              />
              {opt.label}
            </label>
          );
        })}
      </div>
    );
  }

  if (field.target === 'customField') {
    const type = field.customFieldType;
    if (type === 'TEXT') {
      return (
        <input
          id={id}
          type="text"
          required={field.required}
          className={common}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    if (type === 'NUMBER') {
      return (
        <input
          id={id}
          type="text"
          inputMode="decimal"
          required={field.required}
          className={common}
          dir="ltr"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    if (type === 'DATE') {
      return (
        <input
          id={id}
          type="date"
          required={field.required}
          className={common}
          dir="ltr"
          value={(value as string)?.slice(0, 10) ?? ''}
          onChange={(e) => onChange(e.target.value ? `${e.target.value}T00:00:00.000Z` : '')}
        />
      );
    }
    if (type === 'CHECKBOX') {
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    }
    if (type === 'SINGLE_SELECT' && field.options) {
      return (
        <select
          id={id}
          required={field.required}
          className={common}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t('forms.field.selectPlaceholder')}</option>
          {field.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (type === 'MULTI_SELECT' && field.options) {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="space-y-1">
          {field.options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => {
                  onChange(
                    selected.includes(o.id)
                      ? selected.filter((x) => x !== o.id)
                      : [...selected, o.id],
                  );
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    if (type === 'PERSON' && members) {
      return (
        <select
          id={id}
          required={field.required}
          className={common}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t('forms.field.selectPlaceholder')}</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
      );
    }
  }

  return <p className="text-sm text-slate-500">{t('forms.field.unsupported')}</p>;
}
