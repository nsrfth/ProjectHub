import { afterEach, describe, expect, it } from 'vitest';
import { setCalendar } from './calendar';
import {
  formatTimestamp,
  formatTimestampDate,
  resolveTimeZone,
  setDualCalendar,
  setTimeFormat,
  setTimeZone,
} from './datetime';
import { formatShamsiCalendarDate } from './shamsi';

afterEach(() => {
  setTimeZone(null);
  setTimeFormat('H24');
  setDualCalendar(false);
  setCalendar('SHAMSI');
});

describe('formatTimestamp — user timezone', () => {
  const instant = '2026-06-15T15:30:00.000Z';

  it('renders the instant in Asia/Tehran (UTC+3:30 → 19:00)', () => {
    setTimeZone('Asia/Tehran');
    setTimeFormat('H24');
    setCalendar('GREGORIAN');
    expect(formatTimestamp(instant)).toMatch(/2026-06-15.*19:00/);
  });

  it('renders the instant in America/New_York (EDT → 11:30)', () => {
    setTimeZone('America/New_York');
    setCalendar('GREGORIAN');
    expect(formatTimestamp(instant)).toMatch(/2026-06-15.*11:30/);
  });

  it('12h format includes AM/PM under Gregorian', () => {
    setTimeZone('UTC');
    setTimeFormat('H12');
    setCalendar('GREGORIAN');
    const out = formatTimestamp(instant);
    expect(out).toMatch(/PM|AM/);
  });

  it('falls back to browser zone when timeZone unset', () => {
    setTimeZone(null);
    expect(resolveTimeZone()).toBeTruthy();
    expect(formatTimestamp(instant)).toBeTruthy();
  });
});

describe('calendar dates stay UTC-midnight (zone-neutral)', () => {
  const dueDate = '2026-05-22T00:00:00.000Z';

  it('due date is identical in Tehran and New York timezones', () => {
    setCalendar('GREGORIAN');
    setTimeZone('Asia/Tehran');
    const tehran = formatShamsiCalendarDate(dueDate);
    setTimeZone('America/New_York');
    const ny = formatShamsiCalendarDate(dueDate);
    expect(tehran).toBe('2026-05-22');
    expect(ny).toBe('2026-05-22');
  });

  it('timestamp date CAN differ by timezone for the same ISO string', () => {
    const ts = '2026-05-22T02:00:00.000Z';
    setCalendar('GREGORIAN');
    setTimeZone('Asia/Tehran');
    const tehran = formatTimestampDate(ts);
    setTimeZone('America/New_York');
    const ny = formatTimestampDate(ts);
    expect(tehran).not.toBe(ny);
  });
});

describe('dual calendar', () => {
  it('appends the alternate calendar when enabled', () => {
    setDualCalendar(true);
    setCalendar('SHAMSI');
    const out = formatShamsiCalendarDate('2026-05-22T00:00:00.000Z');
    expect(out).toMatch(/\(2026-05-22\)/);
  });

  it('shows primary only when disabled', () => {
    setDualCalendar(false);
    setCalendar('SHAMSI');
    const out = formatShamsiCalendarDate('2026-05-22T00:00:00.000Z');
    expect(out).not.toMatch(/\(/);
  });
});
