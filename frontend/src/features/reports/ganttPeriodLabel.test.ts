import { describe, expect, it } from 'vitest';
import { formatGanttPeriodLabel } from './ganttPeriodLabel';
import { buildGanttAxis } from './ganttScale';
import { jalaliYearOfUtcMs } from '../../lib/shamsi';

// v2.5.59: the YEAR period label used to convert Gregorian Jan 1 to Jalali and
// scrape the year off the end of a formatted long date. Jan 1 sits in Dey of
// the PREVIOUS Jalali year, so the label read one year low over a grid that
// actually spanned parts of two Jalali years. Now the label and the axis are
// both derived from the same window start, so they cannot disagree.

const WEEK_START = 6;

describe('formatGanttPeriodLabel — YEAR', () => {
  it('SHAMSI labels the Jalali year the grid actually spans', () => {
    const anchor = Date.UTC(2026, 6, 18); // 27 Tir 1405
    expect(formatGanttPeriodLabel('year', anchor, WEEK_START, null, 'SHAMSI')).toBe('۱۴۰۵');
  });

  it('SHAMSI label always matches the axis window start', () => {
    // Includes the anchors that exposed the old off-by-one: early January
    // (Dey, previous Jalali year) and late December.
    const anchors = [
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 0, 15),
      Date.UTC(2026, 2, 20), // last day of 1404
      Date.UTC(2026, 2, 21), // Nowruz 1405
      Date.UTC(2026, 6, 18),
      Date.UTC(2026, 11, 31),
    ];
    for (const anchor of anchors) {
      const axis = buildGanttAxis('year', anchor, WEEK_START, anchor, null, 'SHAMSI');
      const label = formatGanttPeriodLabel('year', anchor, WEEK_START, null, 'SHAMSI');
      const expected = String(jalaliYearOfUtcMs(axis.startMs)).replace(
        /\d/g,
        (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)],
      );
      expect(label).toBe(expected);
    }
  });

  it('SHAMSI label is bare Persian digits — no stray parenthesis', () => {
    // The old split-on-whitespace approach returned "2025)" whenever the
    // dual-calendar preference appended "(January 1, 2025)".
    const label = formatGanttPeriodLabel('year', Date.UTC(2026, 6, 18), WEEK_START, null, 'SHAMSI');
    expect(label).toMatch(/^[۰-۹]{4}$/);
  });

  it('the two sides of Nowruz fall in different Jalali years', () => {
    const before = formatGanttPeriodLabel('year', Date.UTC(2026, 2, 20), WEEK_START, null, 'SHAMSI');
    const after = formatGanttPeriodLabel('year', Date.UTC(2026, 2, 21), WEEK_START, null, 'SHAMSI');
    expect(before).toBe('۱۴۰۴');
    expect(after).toBe('۱۴۰۵');
  });

  it('GREGORIAN is unchanged', () => {
    expect(formatGanttPeriodLabel('year', Date.UTC(2026, 6, 18), WEEK_START, null, 'GREGORIAN')).toBe(
      '2026',
    );
    expect(formatGanttPeriodLabel('year', Date.UTC(2026, 0, 1), WEEK_START, null, 'GREGORIAN')).toBe(
      '2026',
    );
  });
});
