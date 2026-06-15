import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildCurrencyRollups,
  computeProjectBudgetMetrics,
} from '../../src/lib/budgetReportMath.js';

describe('computeProjectBudgetMetrics', () => {
  it('returns planned budget when set', () => {
    const m = computeProjectBudgetMetrics(new Prisma.Decimal('1000.00'));
    expect(m.hasBudget).toBe(true);
    expect(m.plannedBudget).toBe('1000.00');
  });

  it('marks no-budget projects without crashing', () => {
    const m = computeProjectBudgetMetrics(null);
    expect(m.hasBudget).toBe(false);
    expect(m.plannedBudget).toBeNull();
  });
});

describe('buildCurrencyRollups', () => {
  it('never sums across currencies', () => {
    const rollups = buildCurrencyRollups([
      {
        currency: 'IRR',
        hasBudget: true,
        plannedBudget: '1000.00',
      },
      {
        currency: 'USD',
        hasBudget: true,
        plannedBudget: '200.00',
      },
    ]);
    expect(rollups).toHaveLength(2);
    const irr = rollups.find((r) => r.currency === 'IRR')!;
    const usd = rollups.find((r) => r.currency === 'USD')!;
    expect(irr.totalPlanned).toBe('1000.00');
    expect(usd.totalPlanned).toBe('200.00');
    expect(irr.projectsWithBudget).toBe(1);
    expect(usd.projectsWithBudget).toBe(1);
  });
});
