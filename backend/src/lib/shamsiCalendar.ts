import DateObject from 'react-date-object';
import persian from 'react-date-object/calendars/persian';
import gregorian from 'react-date-object/calendars/gregorian';

/**
 * Jalali calendar date → UTC-midnight Gregorian instant.
 * Uses the same `react-date-object` library as frontend `lib/shamsi.ts`
 * so import dates match picker/display conversion exactly.
 */
export function jalaliToUtcMidnight(jy: number, jm: number, jd: number): Date {
  const obj = new DateObject({
    year: jy,
    month: jm,
    day: jd,
    calendar: persian,
  });
  const g = obj.convert(gregorian);
  return new Date(Date.UTC(g.year, g.month.number - 1, g.day));
}

/** Inverse of frontend `jalaaliFromUtc` — for tests and validation. */
export function utcMidnightToJalali(date: Date): { jy: number; jm: number; jd: number } {
  const obj = new DateObject({
    date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
    calendar: persian,
  });
  return { jy: obj.year, jm: obj.month.number, jd: obj.day };
}
