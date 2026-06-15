import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildCurrencyRollups,
  computeProjectBudgetMetrics,
} from '../../src/lib/budgetReportMath.js';

describe('computeProjectBudgetMetrics', () => {
  it('computes variance and utilization from stored decimals', () => {
    const m = computeProjectBudgetMetrics(
      new Prisma.Decimal('1000.00'),
      new Prisma.Decimal('750.50'),
    );
    expect(m.plannedBudget).toBe('1000.00');
    expect(m.actualSpent).toBe('750.50');
    expect(m.variance).toBe('249.50');
    expect(m.variancePct).toBe('24.95');
    expect(m.utilizationPct).toBe('75.05');
    expect(m.overBudget).toBe(false);
  });

  it('returns null utilization when planned is zero (no NaN/Infinity)', () => {
    const m = computeProjectBudgetMetrics(new Prisma.Decimal('0'), new Prisma.Decimal('50'));
    expect(m.utilizationPct).toBeNull();
    expect(m.variancePct).toBeNull();
    expect(m.overBudget).toBe(true);
  });

  it('flags overBudget when actual exceeds planned', () => {
    const m = computeProjectBudgetMetrics(
      new Prisma.Decimal('100'),
      new Prisma.Decimal('150'),
    );
    expect(m.overBudget).toBe(true);
    expect(m.variance).toBe('-50.00');
    expect(m.utilizationPct).toBe('150.00');
  });

  it('marks no-budget projects without crashing', () => {
    const m = computeProjectBudgetMetrics(null, null);
    expect(m.hasBudget).toBe(false);
    expect(m.plannedBudget).toBeNull();
    expect(m.utilizationPct).toBeNull();
    expect(m.overBudget).toBe(false);
  });
});

describe('buildCurrencyRollups', () => {
  it('never sums across currencies', () => {
    const rollups = buildCurrencyRollups([
      {
        currency: 'IRR',
        hasBudget: true,
        plannedBudget: '1000.00',
        actualSpent: '900.00',
        overBudget: false,
      },
      {
        currency: 'USD',
        hasBudget: true,
        plannedBudget: '200.00',
        actualSpent: '250.00',
        overBudget: true,
      },
    ]);
    expect(rollups).toHaveLength(2);
    const irr = rollups.find((r) => r.currency === 'IRR')!;
    const usd = rollups.find((r) => r.currency === 'USD')!;
    expect(irr.totalPlanned).toBe('1000.00');
    expect(usd.totalPlanned).toBe('200.00');
    expect(usd.overBudgetCount).toBe(1);
  });
});
