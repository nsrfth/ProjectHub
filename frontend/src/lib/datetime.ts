// v1.63: per-user timestamp display preferences.
// Applies ONLY to category-(b) instants (createdAt, comments, audit, …).
// Calendar dates (dueDate, holidays) stay in shamsi.ts UTC-midnight helpers.

import DateObject from 'react-date-object';
import persian from 'react-date-object/calendars/persian';
import persian_fa from 'react-date-object/locales/persian_fa';
import { getCalendar } from './calendar';

export type TimeFormat = 'H12' | 'H24';

const TZ_KEY = 'taskhub.timeZone';
const TF_KEY = 'taskhub.timeFormat';
const DC_KEY = 'taskhub.dualCalendar';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toPersianDigits(s: string): string {
  return s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

function readStoredTz(): string | null {
  if (typeof window === 'undefined') return null;
  const s = window.localStorage?.getItem(TZ_KEY);
  return s && s.length ? s : null;
}

function readTimeFormat(): TimeFormat {
  if (typeof window === 'undefined') return 'H24';
  return window.localStorage?.getItem(TF_KEY) === 'H12' ? 'H12' : 'H24';
}

function readDual(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage?.getItem(DC_KEY) === 'true';
}

let _timeZone: string | null = readStoredTz();
let _timeFormat: TimeFormat = readTimeFormat();
let _dualCalendar = readDual();

export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export function getTimeZone(): string | null {
  return _timeZone;
}

export function resolveTimeZone(): string {
  return _timeZone ?? getBrowserTimeZone();
}

export function getTimeFormat(): TimeFormat {
  return _timeFormat;
}

export function getDualCalendar(): boolean {
  return _dualCalendar;
}

export function setTimeZone(tz: string | null): boolean {
  const next = tz && tz.length ? tz : null;
  const changed = next !== _timeZone;
  _timeZone = next;
  try {
    if (next) window.localStorage?.setItem(TZ_KEY, next);
    else window.localStorage?.removeItem(TZ_KEY);
  } catch {
    // private-mode Safari
  }
  return changed;
}

export function setTimeFormat(fmt: TimeFormat): boolean {
  const changed = _timeFormat !== fmt;
  _timeFormat = fmt;
  try {
    window.localStorage?.setItem(TF_KEY, fmt);
  } catch {
    // private-mode Safari
  }
  return changed;
}

export function setDualCalendar(on: boolean): boolean {
  const changed = _dualCalendar !== on;
  _dualCalendar = on;
  try {
    window.localStorage?.setItem(DC_KEY, on ? 'true' : 'false');
  } catch {
    // private-mode Safari
  }
  return changed;
}

export function adoptServerDateTimePrefs(
  prefs:
    | {
        timeZone?: string | null;
        timeFormat?: TimeFormat;
        dualCalendar?: boolean;
      }
    | null
    | undefined,
): void {
  if (!prefs) return;
  if (prefs.timeZone !== undefined) setTimeZone(prefs.timeZone);
  if (prefs.timeFormat) setTimeFormat(prefs.timeFormat);
  if (prefs.dualCalendar !== undefined) setDualCalendar(prefs.dualCalendar);
}

function wallClockParts(d: Date, tz: string, hour12: boolean) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: map.hour ?? '00',
    minute: map.minute ?? '00',
    dayPeriod: map.dayPeriod,
  };
}

function jalaliFromGregorianYmd(y: number, m: number, d: number) {
  const obj = new DateObject({
    date: new Date(Date.UTC(y, m - 1, d)),
    calendar: persian,
    locale: persian_fa,
  });
  return { jy: obj.year, jm: obj.month.number, jd: obj.day };
}

/** Category (b): format a UTC instant in the user's timezone + time format. */
export function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = resolveTimeZone();
  const hour12 = getTimeFormat() === 'H12';
  const cal = getCalendar();

  if (cal === 'GREGORIAN') {
    const datePart = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: tz,
    }).format(d);
    const timePart = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12,
      timeZone: tz,
    }).format(d);
    return `${datePart} ${timePart}`;
  }

  const w = wallClockParts(d, tz, hour12);
  const j = jalaliFromGregorianYmd(w.year, w.month, w.day);
  const time = hour12
    ? `${w.hour}:${w.minute}${w.dayPeriod ? ` ${w.dayPeriod}` : ''}`
    : `${pad2(Number(w.hour))}:${w.minute}`;
  return toPersianDigits(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)} ${time}`);
}

/** Category (b): date portion only in the user's timezone. */
export function formatTimestampDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = resolveTimeZone();
  const cal = getCalendar();

  if (cal === 'GREGORIAN') {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: tz,
    }).format(d);
  }

  const w = wallClockParts(d, tz, false);
  const j = jalaliFromGregorianYmd(w.year, w.month, w.day);
  return toPersianDigits(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)}`);
}

export function listIanaTimeZones(): string[] {
  if (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl) {
    return (Intl as unknown as { supportedValuesOf: (key: string) => string[] })
      .supportedValuesOf('timeZone')
      .slice()
      .sort();
  }
  return ['UTC', 'Asia/Tehran', 'America/New_York', 'Europe/London'];
}

export const COMMON_TIME_ZONES = [
  'Asia/Tehran',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Tokyo',
] as const;
