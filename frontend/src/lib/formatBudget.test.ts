import { describe, expect, it } from 'vitest';
import { formatBudget, normalizeBudgetCurrency } from './formatBudget';

describe('normalizeBudgetCurrency', () => {
  it('accepts supported codes case-insensitively', () => {
    expect(normalizeBudgetCurrency('eur')).toBe('EUR');
    expect(normalizeBudgetCurrency(' USD ')).toBe('USD');
  });

  it('falls back to IRR for missing or unknown values', () => {
    expect(normalizeBudgetCurrency(undefined)).toBe('IRR');
    expect(normalizeBudgetCurrency(null)).toBe('IRR');
    expect(normalizeBudgetCurrency('')).toBe('IRR');
    expect(normalizeBudgetCurrency('PLAID')).toBe('IRR');
  });
});

describe('formatBudget', () => {
  it('formats EUR without throwing', () => {
    expect(formatBudget('1000', 'EUR', 'en-US')).toContain('1');
    expect(formatBudget('1000', 'EUR', 'fa-IR')).toBeTruthy();
  });

  it('does not throw when currency is missing (legacy API rows)', () => {
    expect(() => formatBudget('500', undefined, 'fa-IR')).not.toThrow();
    expect(formatBudget('500', undefined, 'fa-IR')).toBeTruthy();
  });

  it('returns em dash for empty amounts', () => {
    expect(formatBudget(null, 'EUR')).toBe('—');
    expect(formatBudget('', 'EUR')).toBe('—');
  });
});
