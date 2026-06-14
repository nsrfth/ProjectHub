import { isOffDay } from './calendar';
import { addDaysUtc, utcDay } from './calendarWeek';

/** Inclusive working-day count between two UTC calendar dates. */
export function countWorkingDaysInclusive(startIso: string, endIso: string): number {
  let from = utcDay(new Date(startIso));
  let to = utcDay(new Date(endIso));
  if (from.getTime() > to.getTime()) {
    const tmp = from;
    from = to;
    to = tmp;
  }
  let count = 0;
  let cur = from;
  while (cur.getTime() <= to.getTime()) {
    if (!isOffDay(cur)) count++;
    cur = addDaysUtc(cur, 1);
  }
  return count;
}

/** Add n signed working days (skips off-days). */
export function addWorkingDaysUtc(from: Date, n: number): Date {
  if (n === 0) return utcDay(from);
  let cur = utcDay(from);
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    cur = addDaysUtc(cur, step);
    if (!isOffDay(cur)) remaining--;
  }
  return cur;
}

/** Calendar-day span (inclusive) between two UTC dates. */
export function countCalendarDaysInclusive(startIso: string, endIso: string): number {
  const from = utcDay(new Date(startIso)).getTime();
  const to = utcDay(new Date(endIso)).getTime();
  return Math.round(Math.abs(to - from) / 86_400_000) + 1;
}
