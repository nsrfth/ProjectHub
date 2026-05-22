import * as jalaali from 'jalaali-js';

// All storage and API transport stays UTC ISO 8601 (Gregorian). This module
// only deals with human-facing display + the bridge between Gregorian
// <input type="date"> values and the Shamsi label shown next to them.

const FA_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

// Convert ASCII digits in a string to Persian (Eastern Arabic) digits so dates
// read naturally for Persian-speaking users. Pure visual.
function toPersianDigits(s: string): string {
  return s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

// Take an ISO 8601 timestamp (or null) and produce a human-readable Shamsi
// date string, e.g. "۱۴۰۵/۰۲/۳۱". Returns null for null/undefined input so
// callers can render absence with a single conditional.
export function formatShamsiDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const { jy, jm, jd } = jalaali.toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const pad = (n: number) => String(n).padStart(2, '0');
  return toPersianDigits(`${jy}/${pad(jm)}/${pad(jd)}`);
}

// Slightly longer form with the Persian month name: e.g. "۳۱ اردیبهشت ۱۴۰۵".
// Used in detail views where space allows the friendlier rendering.
export function formatShamsiLong(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const { jy, jm, jd } = jalaali.toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return toPersianDigits(`${jd} ${FA_MONTHS[jm - 1]} ${jy}`);
}

// Pair with formatShamsiDate when you want HH:MM appended (also Persian digits).
export function formatShamsiDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const { jy, jm, jd } = jalaali.toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const pad = (n: number) => String(n).padStart(2, '0');
  return toPersianDigits(`${jy}/${pad(jm)}/${pad(jd)} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

// Convert an <input type="date"> value (yyyy-mm-dd, local-time Gregorian) into
// an ISO 8601 UTC midnight string for sending to the API. Returns null for
// empty input so the caller can pass it through to a "clear" PATCH.
export function dateInputToISO(value: string): string | null {
  if (!value) return null;
  // value is yyyy-mm-dd. Treat as midnight UTC so the same calendar date is
  // preserved regardless of the user's timezone.
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Convert an ISO string back to a yyyy-mm-dd value suitable for the value=""
// attribute of an <input type="date">. Returns '' for null input.
export function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  // Use UTC components — matches dateInputToISO's UTC-midnight convention.
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
