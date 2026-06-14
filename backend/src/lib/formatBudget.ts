import type { Currency } from '@prisma/client';

const FRACTION_DIGITS: Record<Currency, number> = {
  IRR: 0,
  EUR: 2,
  USD: 2,
};

export type BudgetFormatLocale = 'en-US' | 'fa-IR';

export function formatBudget(
  amount: string | number | null | undefined,
  currency: Currency,
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
