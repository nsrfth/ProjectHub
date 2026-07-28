import { describe, expect, it } from 'vitest';
import {
  MS_DAY,
  buildGanttColumns,
  columnIndexOf,
  msAtOffset,
  offsetOfMs,
  utcDayMs,
  widthOfSpan,
  type GanttColumnSpec,
} from './gantt-geometry';

// The Gantt's whole correctness story is here: if the column array tiles the
// year exactly, every offset, width and hit-test derived from it is right in
// both calendars. These run in plain node — no DOM, no React.

const COL_W = 150;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Columns must tile their span with no gap and no overlap. */
function expectContiguous(columns: GanttColumnSpec[]): void {
  for (let i = 1; i < columns.length; i++) {
    expect(
      columns[i].startMs,
      `column ${i} (${dayOf(columns[i].startMs)}) must start the day after column ${i - 1} ends (${dayOf(columns[i - 1].endMs)})`,
    ).toBe(columns[i - 1].endMs + MS_DAY);
  }
}

describe('buildGanttColumns — Gregorian', () => {
  it('1) builds 12 month columns with real month lengths', () => {
    const cols = buildGanttColumns('monthly', [2026], 'GREGORIAN');
    expect(cols).toHaveLength(12);
    expect(cols.map((c) => c.days)).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    expect(cols.reduce((n, c) => n + c.days, 0)).toBe(365);
  });

  it('2) tiles the year contiguously', () => {
    expectContiguous(buildGanttColumns('monthly', [2025, 2026, 2027], 'GREGORIAN'));
  });

  it('3) handles the leap year', () => {
    const cols = buildGanttColumns('monthly', [2028], 'GREGORIAN');
    expect(cols[1].days).toBe(29);
    expect(cols.reduce((n, c) => n + c.days, 0)).toBe(366);
  });

  it('4) daily range emits one column per day', () => {
    expect(buildGanttColumns('daily', [2026], 'GREGORIAN')).toHaveLength(365);
    expect(buildGanttColumns('daily', [2028], 'GREGORIAN')).toHaveLength(366);
  });

  it('5) groups monthly by year and quarterly by quarter', () => {
    const monthly = buildGanttColumns('monthly', [2026], 'GREGORIAN');
    expect(new Set(monthly.map((c) => c.groupKey))).toEqual(new Set(['2026']));

    const quarterly = buildGanttColumns('quarterly', [2026], 'GREGORIAN');
    expect(quarterly.map((c) => c.groupKey)).toEqual([
      ...Array(3).fill('2026-Q1'),
      ...Array(3).fill('2026-Q2'),
      ...Array(3).fill('2026-Q3'),
      ...Array(3).fill('2026-Q4'),
    ]);
  });
});

describe('buildGanttColumns — Jalali (SHAMSI)', () => {
  // 1405 is a common (non-leap) Jalali year: 6×31 + 5×30 + 29 = 365 days,
  // starting on Nowruz = 2026-03-21.
  const cols = buildGanttColumns('monthly', [1405], 'SHAMSI');

  it('1) starts on Nowruz, not on 1 January', () => {
    expect(dayOf(cols[0].startMs)).toBe('2026-03-21');
    expect(dayOf(cols[11].endMs)).toBe('2027-03-20');
  });

  it('2) uses real Jalali month lengths (6x31, 5x30, then 29)', () => {
    expect(cols.map((c) => c.days)).toEqual([31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29]);
    expect(cols.reduce((n, c) => n + c.days, 0)).toBe(365);
  });

  it('3) tiles consecutive Jalali years contiguously across the year boundary', () => {
    expectContiguous(buildGanttColumns('monthly', [1404, 1405, 1406], 'SHAMSI'));
  });

  it('4) labels months in Persian and the group in Persian digits', () => {
    expect(cols[0].label).toBe('فرو');
    expect(cols[0].groupLabel).toBe('۱۴۰۵');
  });

  it('5) a Gregorian month boundary is NOT a Jalali column boundary', () => {
    // The bug this whole module exists to prevent: date-fns month arithmetic
    // would put a column edge on 1 April; Farvardin runs 21 Mar - 20 Apr.
    const aprilFirst = Date.UTC(2026, 3, 1);
    expect(columnIndexOf(cols, aprilFirst)).toBe(0);
    expect(dayOf(cols[0].endMs)).toBe('2026-04-20');
  });
});

describe('offsetOfMs / msAtOffset', () => {
  const cols = buildGanttColumns('monthly', [2026], 'GREGORIAN');

  it('1) puts the first day of the timeline at 0', () => {
    expect(offsetOfMs(cols, COL_W, Date.UTC(2026, 0, 1))).toBe(0);
  });

  it('2) advances one full column per month', () => {
    expect(offsetOfMs(cols, COL_W, Date.UTC(2026, 1, 1))).toBeCloseTo(COL_W, 6);
    expect(offsetOfMs(cols, COL_W, Date.UTC(2026, 2, 1))).toBeCloseTo(COL_W * 2, 6);
  });

  it('3) positions a mid-month day by its fraction of that month', () => {
    // 16 Jan = 15 days into a 31-day month.
    expect(offsetOfMs(cols, COL_W, Date.UTC(2026, 0, 16))).toBeCloseTo((15 / 31) * COL_W, 6);
  });

  it('4) round-trips back to the same calendar day', () => {
    for (const iso of ['2026-01-01', '2026-02-14', '2026-06-30', '2026-12-31']) {
      const ms = utcDayMs(new Date(`${iso}T00:00:00.000Z`));
      expect(dayOf(msAtOffset(cols, COL_W, offsetOfMs(cols, COL_W, ms)))).toBe(iso);
    }
  });

  it('5) round-trips in Jalali too, where months are not uniform', () => {
    const jalali = buildGanttColumns('monthly', [1405], 'SHAMSI');
    for (const iso of ['2026-03-21', '2026-07-15', '2026-11-01', '2027-03-20']) {
      const ms = utcDayMs(new Date(`${iso}T00:00:00.000Z`));
      expect(dayOf(msAtOffset(jalali, COL_W, offsetOfMs(jalali, COL_W, ms)))).toBe(iso);
    }
  });

  it('6) extrapolates outside the built range instead of clamping to 0', () => {
    expect(offsetOfMs(cols, COL_W, Date.UTC(2025, 11, 31))).toBeLessThan(0);
    expect(offsetOfMs(cols, COL_W, Date.UTC(2027, 0, 1))).toBeGreaterThanOrEqual(COL_W * 12);
  });

  it('7) snaps a pointer offset to a whole day, clamped inside the timeline', () => {
    expect(dayOf(msAtOffset(cols, COL_W, -9999))).toBe('2026-01-01');
    expect(dayOf(msAtOffset(cols, COL_W, 99_999))).toBe('2026-12-31');
  });
});

describe('widthOfSpan', () => {
  const cols = buildGanttColumns('monthly', [2026], 'GREGORIAN');

  it('1) gives a same-day span one real day of width, never zero', () => {
    const day = Date.UTC(2026, 0, 10);
    const width = widthOfSpan(cols, COL_W, day, day);
    expect(width).toBeCloseTo(COL_W / 31, 6);
    expect(width).toBeGreaterThan(0);
  });

  it('2) spans a whole month across exactly one column', () => {
    expect(
      widthOfSpan(cols, COL_W, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 31)),
    ).toBeCloseTo(COL_W, 6);
  });

  it('3) treats the end date as inclusive', () => {
    const oneDay = widthOfSpan(cols, COL_W, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1));
    const twoDays = widthOfSpan(cols, COL_W, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2));
    expect(twoDays).toBeCloseTo(oneDay * 2, 6);
  });

  it('4) survives an inverted range rather than returning a negative width', () => {
    expect(
      widthOfSpan(cols, COL_W, Date.UTC(2026, 5, 1), Date.UTC(2026, 0, 1)),
    ).toBeGreaterThan(0);
  });
});

describe('utcDayMs', () => {
  it('truncates an instant to its UTC calendar day', () => {
    expect(dayOf(utcDayMs(new Date('2026-07-28T23:59:59.999Z')))).toBe('2026-07-28');
    expect(dayOf(utcDayMs(new Date('2026-07-28T00:00:00.000Z')))).toBe('2026-07-28');
  });
});
