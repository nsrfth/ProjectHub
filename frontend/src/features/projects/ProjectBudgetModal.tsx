import { useEffect, useState } from 'react';
import Modal from '@/features/ui/Modal';
import CurrencySelector from '@/features/budget/CurrencySelector';
import type { BudgetCurrency } from '@/lib/formatBudget';
import { budgetLocaleFromLanguage, formatBudget } from '@/lib/formatBudget';
import { getLanguage, useT } from '@/lib/i18n';
import type { ProjectCrossTeam } from '@/features/projects/api';

interface ProjectBudgetModalProps {
  project: ProjectCrossTeam;
  pending: boolean;
  onClose: () => void;
  onSave: (planned: string | null, currency: BudgetCurrency) => void;
}

export default function ProjectBudgetModal({
  project,
  pending,
  onClose,
  onSave,
}: ProjectBudgetModalProps): JSX.Element {
  const t = useT();
  const locale = budgetLocaleFromLanguage(getLanguage());
  const [planned, setPlanned] = useState(project.plannedBudget ?? '');
  const [currency, setCurrency] = useState<BudgetCurrency>(project.budgetCurrency);

  useEffect(() => {
    setPlanned(project.plannedBudget ?? '');
    setCurrency(project.budgetCurrency);
  }, [project.plannedBudget, project.budgetCurrency]);

  const validNumber = (v: string): boolean =>
    v.trim().length === 0 || (/^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) >= 0);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (currency !== project.budgetCurrency && !window.confirm(t('budget.currencyChangeNote'))) {
      return;
    }
    onSave(planned.trim() || null, currency);
  }

  const fmt = (s: string | null): string =>
    formatBudget(s, project.budgetCurrency, locale);

  return (
    <Modal title={t('projects.action.editBudget')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          {project.name}
          {' · '}
          <span dir="ltr">
            {t('budget.currency')}: {fmt(project.plannedBudget)}
          </span>
        </p>
        <label className="flex flex-col gap-1">
          <span>{t('budget.currency')}</span>
          <CurrencySelector
            value={currency}
            onChange={setCurrency}
            className="rounded border px-2 py-1.5 dark:bg-slate-700 w-full max-w-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('projects.budget.planned')}</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={planned}
            onChange={(e) => setPlanned(e.target.value)}
            className="rounded border px-2 py-1.5 dark:bg-slate-700"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded border">
            {t('projects.edit.cancel')}
          </button>
          <button
            type="submit"
            disabled={pending || !validNumber(planned)}
            className="px-3 py-1.5 rounded bg-indigo-600 text-white disabled:opacity-50"
          >
            {t('projects.edit.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
