import type { TeamMember } from '@/features/teams/api';
import CurrencySelector from '@/features/budget/CurrencySelector';
import type { BudgetCurrency } from '@/lib/formatBudget';
import { ShamsiDatePicker } from '@/lib/ShamsiDatePicker';
import { useT } from '@/lib/i18n';
import type { ProjectStatus } from '@/features/projects/api';

export interface ProjectFormValues {
  name: string;
  description: string;
  status: ProjectStatus;
  accountableId: string | null;
  plannedBudget: string;
  actualSpent: string;
  budgetCurrency: BudgetCurrency;
  startDate: string | null;
  endDate: string | null;
}

interface ProjectFormFieldsProps {
  values: ProjectFormValues;
  onChange: (patch: Partial<ProjectFormValues>) => void;
  members: TeamMember[];
  nameOnly?: boolean;
  dateError?: string | null;
}

const STATUSES: ProjectStatus[] = ['ACTIVE', 'ON_HOLD', 'ARCHIVED'];

export function projectFormValuesFromProject(p: {
  name: string;
  description: string | null;
  status: ProjectStatus;
  accountableId: string | null;
  plannedBudget: string | null;
  actualSpent: string | null;
  budgetCurrency: BudgetCurrency;
  startDate: string | null;
  endDate: string | null;
}): ProjectFormValues {
  return {
    name: p.name,
    description: p.description ?? '',
    status: p.status,
    accountableId: p.accountableId,
    plannedBudget: p.plannedBudget ?? '',
    actualSpent: p.actualSpent ?? '',
    budgetCurrency: p.budgetCurrency,
    startDate: p.startDate,
    endDate: p.endDate,
  };
}

export function validateProjectDateRange(
  startDate: string | null,
  endDate: string | null,
): string | null {
  if (!startDate || !endDate) return null;
  if (new Date(endDate).getTime() < new Date(startDate).getTime()) {
    return 'range';
  }
  return null;
}

export default function ProjectFormFields({
  values,
  onChange,
  members,
  nameOnly = false,
  dateError,
}: ProjectFormFieldsProps): JSX.Element {
  const t = useT();
  const locked = nameOnly;

  return (
    <div className="space-y-4">
      <label className="flex flex-col gap-1 text-sm">
        <span>{t('projects.edit.name')}</span>
        <input
          type="text"
          value={values.name}
          onChange={(e) => onChange({ name: e.target.value })}
          maxLength={120}
          required
          className="rounded border px-2 py-1.5 dark:bg-slate-700"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t('projects.edit.description')}</span>
        <textarea
          value={values.description}
          onChange={(e) => onChange({ description: e.target.value })}
          maxLength={2000}
          rows={3}
          disabled={locked}
          className="rounded border px-2 py-1.5 dark:bg-slate-700 resize-y disabled:opacity-60"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t('projects.edit.status')}</span>
        <select
          value={values.status}
          onChange={(e) => onChange({ status: e.target.value as ProjectStatus })}
          disabled={locked}
          className="rounded border px-2 py-1.5 dark:bg-slate-700 disabled:opacity-60"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`projects.status.${s === 'ON_HOLD' ? 'onHold' : s.toLowerCase()}` as never)}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('projects.startDate')}</span>
          <ShamsiDatePicker
            value={values.startDate}
            onChange={(v) => onChange({ startDate: v })}
            disabled={locked}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('projects.endDate')}</span>
          <ShamsiDatePicker
            value={values.endDate}
            onChange={(v) => onChange({ endDate: v })}
            disabled={locked}
          />
        </label>
      </div>
      {dateError && (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {t('projects.dateRange.invalid')}
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span>{t('projects.accountable')}</span>
        <select
          value={values.accountableId ?? ''}
          onChange={(e) => onChange({ accountableId: e.target.value || null })}
          disabled={locked}
          className="rounded border px-2 py-1.5 dark:bg-slate-700 disabled:opacity-60"
        >
          <option value="">{t('projects.accountable.none')}</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name} ({m.role})
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span>{t('budget.currency')}</span>
          <CurrencySelector
            value={values.budgetCurrency}
            onChange={(c) => onChange({ budgetCurrency: c })}
            disabled={locked}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('projects.budget.planned')}</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={values.plannedBudget}
            onChange={(e) => onChange({ plannedBudget: e.target.value })}
            disabled={locked}
            className="rounded border px-2 py-1.5 dark:bg-slate-700 disabled:opacity-60"
            dir="ltr"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('projects.budget.spent')}</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={values.actualSpent}
            onChange={(e) => onChange({ actualSpent: e.target.value })}
            disabled={locked}
            className="rounded border px-2 py-1.5 dark:bg-slate-700 disabled:opacity-60"
            dir="ltr"
          />
        </label>
      </div>
    </div>
  );
}
