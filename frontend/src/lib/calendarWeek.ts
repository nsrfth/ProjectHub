import { getWeekStartDay, getWeekendDays } from './calendar';

const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDaysUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}

export function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
}

export function sameDayUtc(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

/** Weekday indices (0=Sun..6=Sat) in display-column order. */
export function getOrderedWeekdayIndices(weekStart = getWeekStartDay()): number[] {
  return Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
}

export function getOrderedWeekdayLabels(short: boolean, weekStart = getWeekStartDay()): string[] {
  const names = short ? DAY_NAMES_SHORT : DAY_NAMES_FULL;
  return getOrderedWeekdayIndices(weekStart).map((idx) => names[idx]!);
}

/** Start of the 7-day row containing `date`, anchored at the configured week start. */
export function startOfWeekUtc(date: Date, weekStart = getWeekStartDay()): Date {
  const c = utcDay(date);
  const delta = (c.getUTCDay() - weekStart + 7) % 7;
  return addDaysUtc(c, -delta);
}

export type CalendarViewMode = 'work-week' | 'week' | 'month';

function firstWorkdayOnOrAfter(from: Date, off: number[]): Date {
  let d = utcDay(from);
  for (let i = 0; i < 7; i++) {
    if (!off.includes(d.getUTCDay())) return d;
    d = addDaysUtc(d, 1);
  }
  return utcDay(from);
}

/** Visible date cells for the calendar page's three view modes. */
export function rangeForCalendarView(
  view: CalendarViewMode,
  cursor: Date,
  off = getWeekendDays(),
): { start: Date; end: Date; cells: Date[] } {
  const weekStart = getWeekStartDay(off);

  if (view === 'work-week') {
    const start = firstWorkdayOnOrAfter(cursor, off);
    const cells: Date[] = [];
    let d = start;
    while (cells.length < 5) {
      if (!off.includes(d.getUTCDay())) cells.push(d);
      d = addDaysUtc(d, 1);
    }
    const end = addDaysUtc(cells[cells.length - 1]!, 1);
    return { start, end, cells };
  }

  if (view === 'week') {
    const start = startOfWeekUtc(cursor, weekStart);
    const cells = Array.from({ length: 7 }, (_, i) => addDaysUtc(start, i));
    return { start, end: addDaysUtc(start, 7), cells };
  }

  const first = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
  const start = startOfWeekUtc(first, weekStart);
  const cells = Array.from({ length: 42 }, (_, i) => addDaysUtc(start, i));
  return { start, end: addDaysUtc(start, 42), cells };
}

export { DAY_NAMES_FULL };
