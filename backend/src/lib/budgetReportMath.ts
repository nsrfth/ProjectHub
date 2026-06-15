import { Prisma } from '@prisma/client';
import type { Currency } from '@prisma/client';

export interface BudgetProjectMetrics {
  hasBudget: boolean;
  plannedBudget: string | null;
}

export interface BudgetCurrencyRollup {
  currency: Currency;
  projectCount: number;
  projectsWithBudget: number;
  totalPlanned: string | null;
}

export function computeProjectBudgetMetrics(
  planned: Prisma.Decimal | null,
): BudgetProjectMetrics {
  if (planned === null) {
    return {
      hasBudget: false,
      plannedBudget: null,
    };
  }

  return {
    hasBudget: true,
    plannedBudget: planned.toFixed(2),
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
  }[],
): BudgetCurrencyRollup[] {
  const grouped = new Map<Currency, Array<(typeof rows)[number]>>();
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
      const totalPlanned = sumDecimalStrings(plannedParts);

      return {
        currency,
        projectCount: projects.length,
        projectsWithBudget: withBudget.length,
        totalPlanned,
      };
    });
}
