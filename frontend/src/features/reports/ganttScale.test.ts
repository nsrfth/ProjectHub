import {
  barGeometry,
  buildGanttAxis,
  daysBetween,
  DAY_PX,
  MONTH_PX,
  projectBoundsFromRows,
  shiftAnchor,
  todayUtcMs,
  utcDayMs,
  weekStartMs,
  type GanttScaleMode,
} from './ganttScale';
import { describe, expect, it } from 'vitest';

/** Default instance week start (Saturday) — matches getWeekStartDay() for [0,6] off-days. */
const WEEK_START = 6;

function iso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m, d)).toISOString();
}

describe('ganttScale', () => {
  const weekStart = WEEK_START;

  it('MONTH prev/next shifts exactly one calendar month', () => {
    const anchor = Date.UTC(2025, 2, 15); // Mar 15
    const prev = shiftAnchor('month', anchor, -1);
    const next = shiftAnchor('month', anchor, 1);
    expect(new Date(prev).getUTCMonth()).toBe(1);
    expect(new Date(next).getUTCMonth()).toBe(3);
  });

  it('WEEK mode shows 7 day columns', () => {
    const anchor = Date.UTC(2025, 5, 11); // Wed Jun 11
    const axis = buildGanttAxis('week', anchor, weekStart, todayUtcMs(), null, 'GREGORIAN');
    expect(axis.columns).toHaveLength(7);
    expect(axis.chartWidth).toBe(7 * DAY_PX);
  });

  it('WEEK prev/next moves one week', () => {
    const anchor = Date.UTC(2025, 5, 11);
    const prev = shiftAnchor('week', anchor, -1);
    expect(daysBetween(prev, anchor)).toBe(7);
  });

  it('WORKING-WEEK omits off-days from columns (same source as isOffDay)', () => {
    const anchor = Date.UTC(2025, 5, 9); // Mon Jun 9 2025
    const weekAxis = buildGanttAxis('week', anchor, weekStart, todayUtcMs(), null, 'GREGORIAN');
    const workAxis = buildGanttAxis('workingWeek', anchor, weekStart, todayUtcMs(), null, 'GREGORIAN');

    const omitted = weekAxis.columns.filter(
      (c) => c.kind === 'day' && c.offDay,
    );
    expect(omitted.length).toBeGreaterThan(0);
    expect(workAxis.columns.length).toBe(weekAxis.columns.length - omitted.length);

    for (const col of omitted) {
      if (col.kind !== 'day') continue;
      expect(workAxis.workingDayIndex?.has(col.ms)).toBe(false);
    }
  });

  it('YEAR mode uses 12 month columns without per-day rendering', () => {
    const anchor = Date.UTC(2025, 6, 1);
    const axis = buildGanttAxis('year', anchor, weekStart, todayUtcMs(), null, 'GREGORIAN');
    expect(axis.columnKind).toBe('month');
    expect(axis.columns).toHaveLength(12);
    expect(axis.chartWidth).toBe(12 * MONTH_PX);
    expect(axis.columns.every((c) => c.kind === 'month')).toBe(true);
  });

  it('YEAR bar spans proportional months', () => {
    const anchor = Date.UTC(2025, 0, 1);
    const axis = buildGanttAxis('year', anchor, weekStart, todayUtcMs(), null, 'GREGORIAN');
    const start = Date.UTC(2025, 0, 15);
    const end = Date.UTC(2025, 5, 15);
    const geom = barGeometry(start, end, axis);
    expect(geom).not.toBeNull();
    expect(geom!.x).toBeGreaterThan(0);
    expect(geom!.x + geom!.width).toBeLessThanOrEqual(axis.chartWidth);
  });

  it('bar x is stable across scale switches (UTC-midnight)', () => {
    const start = utcDayMs(iso(2025, 5, 10));
    const end = utcDayMs(iso(2025, 5, 12));
    const anchor = Date.UTC(2025, 5, 10);
    const weekAxis = buildGanttAxis('week', anchor, weekStart, todayUtcMs(), null, 'GREGORIAN');
    const geom = barGeometry(start, end, weekAxis);
    expect(geom).not.toBeNull();
    const expectedX = daysBetween(weekAxis.startMs, start) * DAY_PX;
    expect(geom!.x).toBe(expectedX);
    const widthDays = daysBetween(start, end) + 1;
    expect(geom!.width).toBe(widthDays * DAY_PX - 4);
  });

  it('DAY fit mode spans project bounds with day columns', () => {
    const rows = [
      { startDate: iso(2025, 0, 5), endDate: iso(2025, 1, 20) },
    ];
    const bounds = projectBoundsFromRows(rows)!;
    const axis = buildGanttAxis('day', todayUtcMs(), weekStart, todayUtcMs(), bounds, 'GREGORIAN');
    expect(axis.columns.length).toBeGreaterThan(30);
    expect(axis.startMs).toBe(bounds.startMs);
    expect(axis.endMs).toBe(bounds.endMs);
  });

  it('shiftAnchor year moves one year', () => {
    const anchor = Date.UTC(2025, 3, 1);
    const next = shiftAnchor('year', anchor, 1);
    expect(new Date(next).getUTCFullYear()).toBe(2026);
  });

  const modes: GanttScaleMode[] = ['year', 'month', 'week', 'workingWeek', 'day'];
  it.each(modes)('buildGanttAxis produces chart for %s', (mode) => {
    const anchor = Date.UTC(2025, 5, 15);
    const fit = mode === 'day' ? projectBoundsFromRows([
      { startDate: iso(2025, 5, 1), endDate: iso(2025, 5, 20) },
    ]) : null;
    const axis = buildGanttAxis(mode, anchor, weekStart, todayUtcMs(), fit, 'GREGORIAN');
    expect(axis.chartWidth).toBeGreaterThan(0);
    expect(axis.columns.length).toBeGreaterThan(0);
  });
});

// v2.5.59: the YEAR window follows the calendar setting. These assertions pin
// real Nowruz dates, so they also act as a tripwire on react-date-object's
// Jalali leap handling — the conversion we derive every boundary from.
describe('ganttScale YEAR window is calendar-aware', () => {
  const weekStart = WEEK_START;
  const MS_DAY = 86_400_000;

  it('SHAMSI spans Farvardin 1 → Esfand 29/30, not Jan 1 → Dec 31', () => {
    const anchor = Date.UTC(2026, 6, 18); // 27 Tir 1405
    const axis = buildGanttAxis('year', anchor, weekStart, anchor, null, 'SHAMSI');

    expect(axis.startMs).toBe(Date.UTC(2026, 2, 21)); // Nowruz 1405
    expect(axis.endMs).toBe(Date.UTC(2027, 2, 20)); // day before Nowruz 1406
    expect(axis.columns).toHaveLength(12);
    expect(axis.chartWidth).toBe(12 * MONTH_PX);
  });

  it('SHAMSI month columns are contiguous and cover the whole window', () => {
    const anchor = Date.UTC(2026, 6, 18);
    const axis = buildGanttAxis('year', anchor, weekStart, anchor, null, 'SHAMSI');
    const months = axis.columns.filter((c) => c.kind === 'month');

    expect(months[0].kind === 'month' && months[0].monthStartMs).toBe(axis.startMs);
    expect(months[11].kind === 'month' && months[11].monthEndMs).toBe(axis.endMs);

    for (let i = 1; i < months.length; i++) {
      const prev = months[i - 1];
      const cur = months[i];
      if (prev.kind !== 'month' || cur.kind !== 'month') continue;
      // No gap, no overlap: each month starts the day after the last one ends.
      expect(cur.monthStartMs - prev.monthEndMs).toBe(MS_DAY);
    }

    // First six Jalali months are 31 days by definition.
    for (let i = 0; i < 6; i++) {
      const m = months[i];
      if (m.kind !== 'month') continue;
      expect((m.monthEndMs - m.monthStartMs) / MS_DAY + 1).toBe(31);
    }
  });

  it('SHAMSI marks the month actually containing today', () => {
    const anchor = Date.UTC(2026, 6, 18); // 27 Tir → 4th Jalali month
    const axis = buildGanttAxis('year', anchor, weekStart, anchor, null, 'SHAMSI');
    const currentIdx = axis.columns.findIndex(
      (c) => c.kind === 'month' && c.isCurrentMonth,
    );
    expect(currentIdx).toBe(3); // Tir
  });

  it('SHAMSI leap year runs 366 days (Esfand 30)', () => {
    // 1403 is a Jalali leap year: Nowruz 2024-03-20 → 2025-03-20 inclusive.
    const anchor = Date.UTC(2024, 6, 1);
    const axis = buildGanttAxis('year', anchor, weekStart, anchor, null, 'SHAMSI');
    expect((axis.endMs - axis.startMs) / MS_DAY + 1).toBe(366);

    const esfand = axis.columns[11];
    expect(esfand.kind === 'month' && (esfand.monthEndMs - esfand.monthStartMs) / MS_DAY + 1).toBe(
      30,
    );
  });

  it('SHAMSI common year runs 365 days (Esfand 29)', () => {
    const anchor = Date.UTC(2026, 6, 18); // 1405, common
    const axis = buildGanttAxis('year', anchor, weekStart, anchor, null, 'SHAMSI');
    expect((axis.endMs - axis.startMs) / MS_DAY + 1).toBe(365);

    const esfand = axis.columns[11];
    expect(esfand.kind === 'month' && (esfand.monthEndMs - esfand.monthStartMs) / MS_DAY + 1).toBe(
      29,
    );
  });

  it('GREGORIAN window is unchanged by the new parameter', () => {
    const anchor = Date.UTC(2025, 6, 1);
    const axis = buildGanttAxis('year', anchor, weekStart, anchor, null, 'GREGORIAN');
    expect(axis.startMs).toBe(Date.UTC(2025, 0, 1));
    expect(axis.endMs).toBe(Date.UTC(2025, 11, 31));
  });

  it('month labels are localized short names, not bare numerals', () => {
    const anchor = Date.UTC(2026, 6, 18);
    const greg = buildGanttAxis('year', anchor, weekStart, anchor, null, 'GREGORIAN');
    const shamsi = buildGanttAxis('year', anchor, weekStart, anchor, null, 'SHAMSI');

    expect(greg.columns.map((c) => (c.kind === 'month' ? c.label : ''))).toEqual([
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ]);
    expect(shamsi.columns[0].kind === 'month' && shamsi.columns[0].label).toBe('فرو');
    expect(shamsi.columns[11].kind === 'month' && shamsi.columns[11].label).toBe('اسف');
  });

  it('a bar spanning exactly Farvardin maps to the first ~31/365 of the chart', () => {
    const anchor = Date.UTC(2026, 6, 18);
    const axis = buildGanttAxis('year', anchor, weekStart, anchor, null, 'SHAMSI');
    const farvardin = axis.columns[0];
    if (farvardin.kind !== 'month') throw new Error('expected month column');

    const geom = barGeometry(farvardin.monthStartMs, farvardin.monthEndMs, axis);
    expect(geom).not.toBeNull();
    expect(geom!.x).toBe(0);
    // Day-linear placement (the v1.76 approximation), not one whole column.
    const expectedWidth = (31 / 365) * axis.chartWidth - 4;
    expect(geom!.width).toBeCloseTo(expectedWidth, 6);
  });

  it('YEAR navigation lands in the adjacent Jalali year in both directions', () => {
    const anchor = Date.UTC(2026, 6, 18); // 1405
    const next = buildGanttAxis(
      'year', shiftAnchor('year', anchor, 1), weekStart, anchor, null, 'SHAMSI',
    );
    const prev = buildGanttAxis(
      'year', shiftAnchor('year', anchor, -1), weekStart, anchor, null, 'SHAMSI',
    );
    expect(next.startMs).toBe(Date.UTC(2027, 2, 21)); // Nowruz 1406
    expect(prev.startMs).toBe(Date.UTC(2025, 2, 21)); // Nowruz 1404
  });
});

describe('ganttScale weekStartMs', () => {
  it('aligns to configured week start', () => {
    const ms = Date.UTC(2025, 5, 11); // Wed
    const start = weekStartMs(ms, WEEK_START);
    expect(new Date(start).getUTCDay()).toBe(WEEK_START);
  });
});
