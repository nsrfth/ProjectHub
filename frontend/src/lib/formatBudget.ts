export type BudgetCurrency = 'IRR' | 'EUR' | 'USD';

export const BUDGET_CURRENCIES: BudgetCurrency[] = ['IRR', 'EUR', 'USD'];

const FRACTION_DIGITS: Record<BudgetCurrency, number> = {
  IRR: 0,
  EUR: 2,
  USD: 2,
};

export type BudgetFormatLocale = 'en-US' | 'fa-IR';

export function formatBudget(
  amount: string | number | null | undefined,
  currency: BudgetCurrency,
  locale: BudgetFormatLocale = 'en-US',
): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) return '—';
  const digits = FRACTION_DIGITS[currency];
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function budgetLocaleFromLanguage(lang: 'EN' | 'FA'): BudgetFormatLocale {
  return lang === 'FA' ? 'fa-IR' : 'en-US';
}
