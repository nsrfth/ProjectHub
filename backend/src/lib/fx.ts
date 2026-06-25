// v2.0 (PMIS R4 — cost control): FX conversion for the actual-cost ledger.
//
// Every ActualCostEntry snapshots a `baseAmountMinor` in the team's
// reportingCurrency at post time so portfolio roll-ups never re-derive history
// when a rate changes. Conversion reads the FxRate reference table (global,
// seeded with identity rows base==quote rate 1.0 in the R4 migration). When no
// rate is on file for a cross-currency pair the conversion falls back to 1:1 and
// flags a warning rather than blocking the post — a missing rate must never wedge
// a timesheet approval. All math runs through Prisma.Decimal (no float drift).

import { Prisma } from '@prisma/client';
import type { Currency } from '@prisma/client';
import { CURRENCY_DECIMALS } from './money.js';

export interface FxConversion {
  baseAmountMinor: bigint;
  baseCurrency: Currency;
  fxRateId: string | null;
  /** Set when a cross-currency pair had no FxRate and we fell back to 1:1. */
  warning?: string;
}

function pow10(n: number): Prisma.Decimal {
  return new Prisma.Decimal(10).pow(n);
}

/**
 * Convert `amountMinor` (in `from`) to minor units of `to` as of `asOf`.
 * `tx` is any Prisma client (transaction or global). Identity when from==to.
 */
export async function convertMinor(
  client: Prisma.TransactionClient | { fxRate: { findFirst: (args: unknown) => Promise<{ id: string; rate: Prisma.Decimal } | null> } },
  amountMinor: bigint,
  from: Currency,
  to: Currency,
  asOf: Date,
): Promise<FxConversion> {
  if (from === to) {
    return { baseAmountMinor: amountMinor, baseCurrency: to, fxRateId: null };
  }
  const row = await (client as Prisma.TransactionClient).fxRate.findFirst({
    where: { baseCurrency: from, quoteCurrency: to, asOf: { lte: asOf } },
    orderBy: { asOf: 'desc' },
    select: { id: true, rate: true },
  });

  const fromDec = CURRENCY_DECIMALS[from];
  const toDec = CURRENCY_DECIMALS[to];

  if (!row) {
    // No rate on file: keep the numeric magnitude, only rescale decimals.
    const rescaled = new Prisma.Decimal(amountMinor.toString())
      .div(pow10(fromDec))
      .mul(pow10(toDec));
    return {
      baseAmountMinor: BigInt(rescaled.toFixed(0)),
      baseCurrency: to,
      fxRateId: null,
      warning: `No FX rate ${from}->${to} on or before ${asOf.toISOString().slice(0, 10)}; used 1:1`,
    };
  }

  // baseMinor = amountMinor / 10^fromDec * rate * 10^toDec
  const base = new Prisma.Decimal(amountMinor.toString())
    .div(pow10(fromDec))
    .mul(row.rate)
    .mul(pow10(toDec));
  return {
    baseAmountMinor: BigInt(base.toFixed(0)),
    baseCurrency: to,
    fxRateId: row.id,
  };
}
