import { describe, expect, it } from 'vitest';
import { jalaliToUtcMidnight, utcMidnightToJalali } from '../../src/lib/shamsiCalendar.js';

describe('shamsiCalendar (react-date-object)', () => {
  it('Nowruz 1405 → 2026-03-21 UTC midnight (react-date-object)', () => {
    expect(jalaliToUtcMidnight(1405, 1, 1).toISOString()).toBe('2026-03-21T00:00:00.000Z');
  });

  it('round-trips through utcMidnightToJalali', () => {
    const iso = '2026-03-21T00:00:00.000Z';
    expect(utcMidnightToJalali(new Date(iso))).toEqual({ jy: 1405, jm: 1, jd: 1 });
  });
});
