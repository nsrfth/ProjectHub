import { Prisma } from '@prisma/client';
import type { Currency } from '@prisma/client';

export interface BudgetProjectMetrics {
  hasBudget: boolean;
  plannedBudget: string | null;
  actualSpent: string | null;
  variance: string | null;
  variancePct: string | null;
  utilizationPct: string | null;
  overBudget: boolean;
}

export interface BudgetCurrencyRollup {
  currency: Currency;
  projectCount: number;
  projectsWithBudget: number;
  totalPlanned: string | null;
  totalActual: string | null;
  totalVariance: string | null;
  overBudgetCount: number;
}

export function computeProjectBudgetMetrics(
  planned: Prisma.Decimal | null,
  actual: Prisma.Decimal | null,
): BudgetProjectMetrics {
  const hasBudget = planned !== null || actual !== null;
  if (!hasBudget) {
    return {
      hasBudget: false,
      plannedBudget: null,
      actualSpent: null,
      variance: null,
      variancePct: null,
      utilizationPct: null,
      overBudget: false,
    };
  }

  const plannedDec = planned ?? new Prisma.Decimal(0);
  const actualDec = actual ?? new Prisma.Decimal(0);

  const variance =
    planned !== null ? plannedDec.minus(actualDec).toFixed(2) : null;

  let variancePct: string | null = null;
  if (planned !== null && !plannedDec.isZero()) {
    variancePct = plannedDec.minus(actualDec).div(plannedDec).mul(100).toFixed(2);
  }

  let utilizationPct: string | null = null;
  if (planned !== null && !plannedDec.isZero()) {
    utilizationPct = actualDec.div(plannedDec).mul(100).toFixed(2);
  }

  const overBudget = planned !== null && actualDec.greaterThan(plannedDec);

  return {
    hasBudget: true,
    plannedBudget: planned !== null ? planned.toFixed(2) : null,
    actualSpent: actual !== null ? actual.toFixed(2) : null,
    variance,
    variancePct,
    utilizationPct,
    overBudget,
  };
}

function sumDecimalStrings(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const total = values.reduce(
    (acc, v) => acc.add(new Prisma.Decimal(v)),
    new Prisma.Decimal(0),
  );
  return total.toFixed(2);
}

export function buildCurrencyRollups(
  rows: readonly {
    currency: Currency;
    hasBudget: boolean;
    plannedBudget: string | null;
    actualSpent: string | null;
    overBudget: boolean;
  }[],
): BudgetCurrencyRollup[] {
  const grouped = new Map<Currency, typeof rows>();
  for (const row of rows) {
    const bucket = grouped.get(row.currency) ?? [];
    bucket.push(row);
    grouped.set(row.currency, bucket);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, projects]) => {
      const withBudget = projects.filter((p) => p.hasBudget);
      const plannedParts = withBudget
        .map((p) => p.plannedBudget)
        .filter((v): v is string => v !== null);
      const actualParts = withBudget
        .map((p) => p.actualSpent)
        .filter((v): v is string => v !== null);
      const totalPlanned = sumDecimalStrings(plannedParts);
      const totalActual = sumDecimalStrings(actualParts);
      const totalVariance =
        totalPlanned !== null && totalActual !== null
          ? new Prisma.Decimal(totalPlanned).minus(totalActual).toFixed(2)
          : totalPlanned !== null
            ? new Prisma.Decimal(totalPlanned).toFixed(2)
            : totalActual !== null
              ? new Prisma.Decimal(totalActual).negated().toFixed(2)
              : null;

      return {
        currency,
        projectCount: projects.length,
        projectsWithBudget: withBudget.length,
        totalPlanned,
        totalActual,
        totalVariance,
        overBudgetCount: withBudget.filter((p) => p.overBudget).length,
      };
    });
}
