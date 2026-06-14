import { useT } from '@/lib/i18n';
import type { BudgetCurrency } from '@/lib/formatBudget';
import { BUDGET_CURRENCIES } from '@/lib/formatBudget';

export type { BudgetCurrency };
export { BUDGET_CURRENCIES };

export function currencyLabel(t: (key: string) => string, code: BudgetCurrency): string {
  return t(`budget.currency.${code.toLowerCase()}`);
}

export default function CurrencySelector({
  value,
  onChange,
  disabled,
  className = '',
  id,
}: {
  value: BudgetCurrency;
  onChange: (next: BudgetCurrency) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}): JSX.Element {
  const t = useT();
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as BudgetCurrency)}
      className={
        className ||
        'rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1.5 border text-sm'
      }
    >
      {BUDGET_CURRENCIES.map((c) => (
        <option key={c} value={c}>
          {currencyLabel(t, c)}
        </option>
      ))}
    </select>
  );
}
