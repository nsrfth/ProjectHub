import { z } from 'zod';

import { normalizeUtcMidnight } from '../services/holidaysService.js';

/** ISO datetime wire field for UTC-midnight calendar dates (dueDate, holidays, project dates). */
export const calendarDateField = z.string().datetime().nullable().optional();

export function normalizeOptionalCalendarDate(
  input: string | null | undefined,
): Date | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  return normalizeUtcMidnight(input);
}

export function calendarDateToIso(date: Date | null | undefined): string | null {
  if (!date) return null;
  return date.toISOString();
}

export function assertEndOnOrAfterStart(
  start: Date | null | undefined,
  end: Date | null | undefined,
): void {
  if (!start || !end) return;
  if (end.getTime() < start.getTime()) {
    throw new Error('endDate must be on or after startDate');
  }
}

export function refineCalendarDateRange<
  T extends { startDate?: string | null; endDate?: string | null },
>(v: T, ctx: z.RefinementCtx): void {
  if (v.startDate == null || v.endDate == null) return;
  if (v.startDate === undefined || v.endDate === undefined) return;
  const start = normalizeUtcMidnight(v.startDate);
  const end = normalizeUtcMidnight(v.endDate);
  if (end.getTime() < start.getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'endDate must be on or after startDate',
      path: ['endDate'],
    });
  }
}
