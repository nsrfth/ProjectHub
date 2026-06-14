import { describe, expect, it } from 'vitest';
import { formatBudget } from '../../src/lib/formatBudget.js';

describe('formatBudget', () => {
  it('formats EUR with 2 decimals in en-US', () => {
    const out = formatBudget('12000', 'EUR', 'en-US');
    expect(out).toContain('12,000.00');
    expect(out).toMatch(/€|EUR/);
  });

  it('formats IRR with 0 decimals in en-US', () => {
    const out = formatBudget('12000.00', 'IRR', 'en-US');
    expect(out).not.toContain('.00');
    expect(out).toContain('12,000');
  });

  it('formats with Persian digits in fa-IR', () => {
    const out = formatBudget('12000', 'EUR', 'fa-IR');
    expect(out).toMatch(/[\u06F0-\u06F9]/);
  });
});
