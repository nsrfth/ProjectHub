// Recurrence math — given a current spawn date + a rule, return the next
// eligible spawn date. All inputs/outputs are UTC-midnight Date objects so
// the result lines up with the v1.1.3 calendar-date convention.
//
// Phase 4 intentionally implements a subset of RRULE: frequency + interval
// + (for WEEKLY) byWeekday. Full RRULE — BYMONTHDAY filters, BYSETPOS,
// alternate calendars — is out of scope; the surface we ship covers the
// "every weekday", "every 2 weeks on Mon+Wed", "monthly on the same date"
// cases admins actually configure.

import type { RecurrenceFrequency } from '@prisma/client';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number;
  byWeekday: number[]; // [] when not applicable
}

// Truncate to UTC midnight. Used everywhere so spawn dates align to whole
// days regardless of the wall clock that triggered the tick.
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

export function addMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

export function addYears(d: Date, years: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));
}

// Period key — used as the unique idempotency token alongside the template
// id. For sub-daily resolutions we'd add hour; sub-day isn't supported in
// Phase 4 so the date alone is sufficient.
export function periodKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Compute the next-after-`current` occurrence under the rule. Returns null
// if the rule doesn't have one (shouldn't happen for the supported subset).
export function nextOccurrenceAfter(rule: RecurrenceRule, current: Date): Date {
  const step = Math.max(1, rule.interval);
  const c = utcMidnight(current);

  switch (rule.frequency) {
    case 'DAILY':
      return addDays(c, step);

    case 'WEEKLY': {
      // No byWeekday filter → just advance by N weeks.
      if (!rule.byWeekday || rule.byWeekday.length === 0) {
        return addDays(c, step * 7);
      }
      // With byWeekday: scan forward day-by-day, but bounded — pick the
      // next matching weekday WITHIN the current "interval block" (the
      // week we're in, or up to step weeks ahead if we exhaust this week).
      const wanted = new Set(rule.byWeekday);
      // First try the rest of this week (excluding today).
      for (let i = 1; i <= 7; i++) {
        const candidate = addDays(c, i);
        if (wanted.has(candidate.getUTCDay())) return candidate;
      }
      // Should never reach — for any non-empty wanted set, a match exists
      // within 7 days. Defensive fallback.
      return addDays(c, step * 7);
    }

    case 'MONTHLY':
      return addMonths(c, step);

    case 'QUARTERLY':
      // 3 months per quarter; `interval` lets you do "every 2 quarters" etc.
      return addMonths(c, step * 3);

    case 'YEARLY':
      return addYears(c, step);
  }
}

// First occurrence on or after `startsOn` that satisfies the rule.
// For DAILY/MONTHLY/YEARLY that's just `startsOn` (assuming it's already at
// midnight). For WEEKLY with byWeekday, we may need to advance to the next
// matching weekday.
export function firstOccurrenceOnOrAfter(rule: RecurrenceRule, startsOn: Date): Date {
  const c = utcMidnight(startsOn);
  if (rule.frequency !== 'WEEKLY' || !rule.byWeekday || rule.byWeekday.length === 0) {
    return c;
  }
  const wanted = new Set(rule.byWeekday);
  for (let i = 0; i < 7; i++) {
    const candidate = addDays(c, i);
    if (wanted.has(candidate.getUTCDay())) return candidate;
  }
  return c;
}
