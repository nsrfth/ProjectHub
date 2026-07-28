// Pure geometry for the interactive Gantt (components/ui/gantt.tsx).
//
// Split out of the component so vitest can exercise it directly: the suite
// runs on `environment: 'node'`, collects only `*.test.ts`, and resolves no
// `@` alias — hence the relative imports below, matching ganttScale.ts.
//
// The model is deliberately NOT date-fns month arithmetic. The timeline is a
// flat array of explicit column bounds, so a Jalali month (29/30/31 days,
// starting mid-Gregorian-month) is described exactly the same way as a
// Gregorian one, and every offset/width/hit-test is a lookup into that array
// rather than a calendar assumption. All instants are UTC-midnight calendar
// days, the repo-wide convention for dates without a time.

import { isOffDay, type Calendar } from '../../lib/calendar';
import {
  jalaliMonthShortName,
  jalaliYearMonths,
  toPersianDigits,
} from '../../lib/shamsi';

export const MS_DAY = 86_400_000;

export type Range = 'daily' | 'monthly' | 'quarterly';

/** One header cell / grid column: an explicit calendar-day span. */
export interface GanttColumnSpec {
  /** UTC-midnight ms of the column's first day. */
  startMs: number;
  /** UTC-midnight ms of the column's last day (inclusive). */
  endMs: number;
  days: number;
  label: string;
  /** Identity of the sticky group header this column sits under. */
  groupKey: string;
  groupLabel: string;
  /** Daily range only — weekend or holiday, tinted with the offday token. */
  isOff: boolean;
}

export const BASE_COLUMN_WIDTH: Record<Range, number> = {
  daily: 50,
  monthly: 150,
  quarterly: 100,
};

export function utcDayMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function todayUtcMs(): number {
  return utcDayMs(new Date());
}

const gregorianMonthLabel = (ms: number): string =>
  new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short' }).format(new Date(ms));

function monthsOfYear(
  year: number,
  calendar: Calendar,
): Array<{ startMs: number; endMs: number; label: string }> {
  if (calendar === 'SHAMSI') {
    return jalaliYearMonths(year).map((m, i) => ({ ...m, label: jalaliMonthShortName(i) }));
  }
  return Array.from({ length: 12 }, (_, m) => {
    const startMs = Date.UTC(year, m, 1);
    return { startMs, endMs: Date.UTC(year, m + 1, 0), label: gregorianMonthLabel(startMs) };
  });
}

function yearLabel(year: number, calendar: Calendar): string {
  return calendar === 'SHAMSI' ? toPersianDigits(String(year)) : String(year);
}

/**
 * Flatten the requested calendar years into contiguous columns. `years` are
 * Jalali years under SHAMSI and Gregorian years otherwise, so the timeline
 * always starts on a real new-year boundary in the user's own calendar.
 */
export function buildGanttColumns(
  range: Range,
  years: number[],
  calendar: Calendar,
): GanttColumnSpec[] {
  const columns: GanttColumnSpec[] = [];

  for (const year of years) {
    monthsOfYear(year, calendar).forEach((month, monthIndex) => {
      const days = Math.round((month.endMs - month.startMs) / MS_DAY) + 1;

      if (range === 'daily') {
        const groupKey = `${year}-${monthIndex}`;
        const groupLabel = `${month.label} ${yearLabel(year, calendar)}`;
        for (let d = 0; d < days; d++) {
          const startMs = month.startMs + d * MS_DAY;
          columns.push({
            startMs,
            endMs: startMs,
            days: 1,
            label:
              calendar === 'SHAMSI'
                ? toPersianDigits(String(d + 1))
                : String(new Date(startMs).getUTCDate()),
            groupKey,
            groupLabel,
            isOff: isOffDay(new Date(startMs)),
          });
        }
        return;
      }

      const quarter = Math.floor(monthIndex / 3) + 1;
      columns.push({
        startMs: month.startMs,
        endMs: month.endMs,
        days,
        label: month.label,
        groupKey: range === 'quarterly' ? `${year}-Q${quarter}` : String(year),
        groupLabel:
          range === 'quarterly'
            ? `Q${quarter} ${yearLabel(year, calendar)}`
            : yearLabel(year, calendar),
        isOff: false,
      });
    });
  }

  return columns;
}

/** Index of the column containing `ms`, or -1 when outside the timeline. */
export function columnIndexOf(columns: GanttColumnSpec[], ms: number): number {
  if (!columns.length) return -1;
  if (ms < columns[0].startMs) return -1;
  if (ms > columns[columns.length - 1].endMs) return -1;
  let lo = 0;
  let hi = columns.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (columns[mid].startMs <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Pixel offset of a calendar day from the timeline's left edge. Days outside
 * the built range extrapolate linearly off the nearest end, so a bar running
 * past the loaded years still points the right way instead of clamping.
 */
export function offsetOfMs(
  columns: GanttColumnSpec[],
  colW: number,
  ms: number,
): number {
  if (!columns.length) return 0;

  const first = columns[0];
  if (ms < first.startMs) {
    return ((ms - first.startMs) / MS_DAY / first.days) * colW;
  }

  const last = columns[columns.length - 1];
  const endExclusive = last.endMs + MS_DAY;
  if (ms >= endExclusive) {
    return columns.length * colW + ((ms - endExclusive) / MS_DAY / last.days) * colW;
  }

  const index = columnIndexOf(columns, ms);
  if (index < 0) return 0;
  const column = columns[index];
  return index * colW + ((ms - column.startMs) / MS_DAY / column.days) * colW;
}

/** Inverse of offsetOfMs — snapped to a whole calendar day. */
export function msAtOffset(
  columns: GanttColumnSpec[],
  colW: number,
  x: number,
): number {
  if (!columns.length) return todayUtcMs();
  const index = Math.min(Math.max(Math.floor(x / colW), 0), columns.length - 1);
  const column = columns[index];
  const fraction = (x - index * colW) / colW;
  // EPSILON matters. offsetOfMs(day) yields index*colW + (d/days)*colW; feeding
  // that straight back can land on d - 1e-16, and a bare floor() then reports
  // the PREVIOUS day. That is a one-day drift on every drag and on the marker
  // hit-test — worse in Jalali, where irregular month lengths make the exact
  // binary fractions rarer. Nudging up past the representation error costs
  // nothing for a genuine mid-day pointer position.
  const dayOffset = Math.min(
    Math.max(Math.floor(fraction * column.days + 1e-9), 0),
    column.days - 1,
  );
  return column.startMs + dayOffset * MS_DAY;
}

/**
 * Width in px of an INCLUSIVE [startMs, endMs] calendar-day span. Inclusive
 * ends are the repo convention, and they remove upstream's zero-width
 * same-day bar (which it patched with a `delta ? delta : 1` fallback).
 */
export function widthOfSpan(
  columns: GanttColumnSpec[],
  colW: number,
  startMs: number,
  endMs: number,
): number {
  const left = offsetOfMs(columns, colW, startMs);
  const right = offsetOfMs(columns, colW, Math.max(endMs, startMs) + MS_DAY);
  return Math.max(right - left, 2);
}
