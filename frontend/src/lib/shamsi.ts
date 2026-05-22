import DateObject from 'react-date-object';
import persian from 'react-date-object/calendars/persian';
import persian_fa from 'react-date-object/locales/persian_fa';

// Two date concepts the app must handle differently:
//
//   1. CALENDAR DATES — dueDate, doneAt-as-picked. The user picked "May 22" and
//      every other user looking at this task should see "May 22" regardless of
//      their browser's timezone. We anchor these to UTC midnight in storage
//      and read UTC components when formatting (use `formatShamsiCalendarDate`
//      / `formatShamsiCalendarLong`).
//
//   2. TIMESTAMPS — createdAt, updatedAt, joinedAt, comment/activity/notification
//      timestamps. These are points in time and SHOULD shift to the viewer's
//      local timezone — "I commented at 3pm my time" is what the reader cares
//      about. We read local components for these (use `formatShamsiTimestamp`
//      / `formatShamsiTimestampDate` / `formatRelativeTime`).
//
// Mixing the two is the source of "wrong day" bugs — a calendar date stored
// at 2026-05-22T00:00:00Z renders as May 21 to a PST viewer if you read
// local components. Use the right helper for the field's semantics.

// `react-date-object` already does the Gregorian→Jalali conversion the picker
// uses; we consolidate on it here so we have one library doing the math.

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

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toPersianDigits(s: string): string {
  return s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

// ------- Calendar dates (UTC-anchored) ----------------------------------

// Convert ISO → {jy, jm, jd} reading UTC components. Use this for fields the
// user picks as a calendar date (dueDate, doneAt).
function jalaaliFromUtc(iso: string): { jy: number; jm: number; jd: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const obj = new DateObject({
    date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())),
    calendar: persian,
    locale: persian_fa,
  });
  return { jy: obj.year, jm: obj.month.number, jd: obj.day };
}

export function formatShamsiCalendarDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const j = jalaaliFromUtc(iso);
  if (!j) return null;
  return toPersianDigits(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)}`);
}

export function formatShamsiCalendarLong(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const j = jalaaliFromUtc(iso);
  if (!j) return null;
  return toPersianDigits(`${j.jd} ${FA_MONTHS[j.jm - 1]} ${j.jy}`);
}

// ------- Timestamps (local-time) ----------------------------------------

function jalaaliFromLocal(d: Date): { jy: number; jm: number; jd: number; h: number; mi: number } | null {
  if (Number.isNaN(d.getTime())) return null;
  // Build the DateObject from local components — react-date-object then does
  // the Gregorian→Jalali math on those numbers without any TZ shift.
  const obj = new DateObject({
    date: new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()),
    calendar: persian,
    locale: persian_fa,
  });
  return { jy: obj.year, jm: obj.month.number, jd: obj.day, h: d.getHours(), mi: d.getMinutes() };
}

// `2026-05-22T15:30:00Z` → "۱۴۰۵/۰۳/۰۱ ۱۹:۰۰" (in Iran). Use for timestamp
// fields where the time-of-day matters (comments, activity, notifications).
export function formatShamsiTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const j = jalaaliFromLocal(d);
  if (!j) return null;
  return toPersianDigits(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)} ${pad2(j.h)}:${pad2(j.mi)}`);
}

// Same as formatShamsiTimestamp but without the time portion. Use for
// "Joined on" / "Created on" rows where time is noise.
export function formatShamsiTimestampDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const j = jalaaliFromLocal(d);
  if (!j) return null;
  return toPersianDigits(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)}`);
}

// ------- Relative time (local-time, Persian locale) ---------------------

const rtf = new Intl.RelativeTimeFormat('fa-IR', { numeric: 'auto' });

// "۵ دقیقه پیش" / "دیروز" / "هفته آینده" etc. Best for comment / activity /
// notification timestamps where the reader cares about "how recent" more than
// "exactly when". Falls back to the full Shamsi timestamp once the event is
// older than ~30 days, where relative wording stops being useful.
export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = then - Date.now();
  const absDays = Math.abs(diffMs) / (24 * 60 * 60 * 1000);
  if (absDays > 30) return formatShamsiTimestamp(iso);

  const absSec = Math.abs(diffMs) / 1000;
  const sign = diffMs < 0 ? -1 : 1;
  if (absSec < 60) return rtf.format(sign * Math.round(absSec), 'second');
  if (absSec < 3600) return rtf.format(sign * Math.round(absSec / 60), 'minute');
  if (absSec < 86400) return rtf.format(sign * Math.round(absSec / 3600), 'hour');
  return rtf.format(sign * Math.round(absSec / 86400), 'day');
}

// ------- Back-compat aliases --------------------------------------------
//
// Existing call sites import `formatShamsiDate` / `formatShamsiLong` /
// `formatShamsiDateTime`. Keeping the names as aliases means we don't have
// to rewrite every file when only the SEMANTIC of "which kind of date" is
// changing. The aliases below are deliberate about which underlying helper
// each one delegates to, so legacy call sites stay correct after this patch:
//
//   - formatShamsiDate: used for dueDate (calendar) AND createdAt/joinedAt
//     (timestamp). Default to the calendar variant — the bug fix that
//     motivated this work — and update timestamp call sites explicitly.
//   - formatShamsiLong: only ever used for calendar dates today (dueDate/
//     doneAt detail), so it goes to the calendar variant.
//   - formatShamsiDateTime: only ever used for timestamps today.

export const formatShamsiDate = formatShamsiCalendarDate;
export const formatShamsiLong = formatShamsiCalendarLong;
export const formatShamsiDateTime = formatShamsiTimestamp;
