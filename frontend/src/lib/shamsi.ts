import DateObject from 'react-date-object';
import persian from 'react-date-object/calendars/persian';
import persian_fa from 'react-date-object/locales/persian_fa';
import { getCalendar } from './calendar';
import { formatTimestamp, formatTimestampDate, getDualCalendar } from './datetime';

// v1.10: every formatter below branches on the active calendar. The
// SHAMSI path is the existing Jalali code; the GREGORIAN path delegates
// to native Intl + native Date so non-Persian-reading users see familiar
// "May 22, 2026" / "2026-05-22 15:30" output. Toggling requires a page
// reload (the Preferences page does it after saving).

// Two date concepts the app must handle differently:
//
//   1. CALENDAR DATES — dueDate, doneAt-as-picked. The user picked "May 22" and
//      every other user looking at this task should see "May 22" regardless of
//      their browser's timezone. We anchor these to UTC midnight in storage
//      and read UTC components when formatting (use `formatShamsiCalendarDate`
//      / `formatShamsiCalendarLong`).
//
//   2. TIMESTAMPS — createdAt, completedAt, comment/activity/notification times.
//      True instants stored in UTC; rendered in the user's chosen IANA timezone
//      + 12h/24h format via lib/datetime.ts (`formatShamsiTimestamp`,
//      `formatShamsiTimestampDate`, `formatRelativeTime`).
//
// Mixing the two is the source of "wrong day" bugs — a calendar date stored
// at 2026-05-22T00:00:00Z renders as May 21 to a PST viewer if you read
// local components. Use the right helper for the field's semantics.

// `react-date-object` already does the Gregorian→Jalali conversion the picker
// uses; we consolidate on it here so we have one library doing the math.

const MS_DAY = 86_400_000;

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

// v2.5.59: abbreviated forms for the year-timeline month axis (72px columns).
const FA_MONTHS_SHORT = [
  'فرو',
  'ارد',
  'خرد',
  'تیر',
  'مرد',
  'شهر',
  'مهر',
  'آبا',
  'آذر',
  'دی',
  'بهم',
  'اسف',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function toPersianDigits(s: string): string {
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

// ------- Jalali year/month boundaries (v2.5.59) --------------------------
//
// The year-timeline axis needs the REVERSE of `jalaaliFromUtc`: "which UTC
// day is Farvardin 1 of Jalali year N?". `react-date-object` is only a
// transitive dependency here (it arrives via react-multi-date-picker) and we
// deliberately lean on nothing but its forward conversion, which is the path
// already proven in production by the formatters above.
//
// Nowruz always falls on 19–22 March of Gregorian year jy + 621, so probing
// those four days with the forward conversion pins Farvardin 1 exactly — in
// leap and common years alike, with no leap rule encoded anywhere.
//
// TZ note: the probe builds LOCAL-midnight Dates because DateObject reads
// local components. `new Date(y, m, d)` round-trips to the same y/m/d in
// every timezone; `new Date(Date.UTC(y, m, d))` does not — it reads back as
// the previous day anywhere west of Greenwich, which is the latent hazard in
// `jalaaliFromUtc` above (harmless at +03:30, wrong in the Americas).
function jalaaliFromLocalYmd(
  gy: number,
  gm0: number,
  gd: number,
): { jy: number; jm: number; jd: number } {
  const obj = new DateObject({
    date: new Date(gy, gm0, gd),
    calendar: persian,
    locale: persian_fa,
  });
  return { jy: obj.year, jm: obj.month.number, jd: obj.day };
}

/** Jalali year containing the given UTC-midnight calendar day. */
export function jalaliYearOfUtcMs(ms: number): number {
  const d = new Date(ms);
  return jalaaliFromLocalYmd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).jy;
}

/** UTC ms of Farvardin 1 (Nowruz) of the given Jalali year. */
export function jalaliYearStartUtcMs(jy: number): number {
  const gy = jy + 621;
  for (let day = 19; day <= 22; day++) {
    const p = jalaaliFromLocalYmd(gy, 2, day);
    if (p.jy === jy && p.jm === 1 && p.jd === 1) return Date.UTC(gy, 2, day);
  }
  // Unreachable for any real Jalali year. Keep the axis renderable rather
  // than throwing if the conversion library ever changes shape.
  return Date.UTC(gy, 2, 21);
}

// Month lengths are DEFINITIONAL in the modern Solar Hijri calendar: months
// 1–6 are 31 days, months 7–11 are 30. Only Esfand varies (29 or 30), and we
// derive its end from the following Nowruz instead of encoding a leap rule.
const JALALI_MONTH_START_OFFSET = [0, 31, 62, 93, 124, 155, 186, 216, 246, 276, 306, 336];

/** 12 × UTC-ms month bounds for a Jalali year. Esfand is leap-aware. */
export function jalaliYearMonths(jy: number): Array<{ startMs: number; endMs: number }> {
  const yearStart = jalaliYearStartUtcMs(jy);
  const nextYearStart = jalaliYearStartUtcMs(jy + 1);
  return JALALI_MONTH_START_OFFSET.map((offset, i) => ({
    startMs: yearStart + offset * MS_DAY,
    endMs:
      (i === 11
        ? nextYearStart
        : yearStart + JALALI_MONTH_START_OFFSET[i + 1] * MS_DAY) - MS_DAY,
  }));
}

/** Abbreviated Persian month name by 0-based index (فرو … اسف). */
export function jalaliMonthShortName(monthIndex0: number): string {
  return FA_MONTHS_SHORT[monthIndex0] ?? '';
}

// Gregorian short calendar date (UTC components → "2026-05-22").
function formatGregorianCalendarDateUtc(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  return `${y}-${m}-${day}`;
}

// Gregorian long calendar date (UTC components → "May 22, 2026").
function formatGregorianCalendarLongUtc(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(d);
}

function formatShamsiOnlyShort(iso: string): string | null {
  const j = jalaaliFromUtc(iso);
  if (!j) return null;
  return toPersianDigits(`${j.jy}/${pad2(j.jm)}/${pad2(j.jd)}`);
}

function formatShamsiOnlyLong(iso: string): string | null {
  const j = jalaaliFromUtc(iso);
  if (!j) return null;
  return toPersianDigits(`${j.jd} ${FA_MONTHS[j.jm - 1]} ${j.jy}`);
}

function withDualCalendar(iso: string, primary: string, long: boolean): string {
  if (!getDualCalendar()) return primary;
  const greg = long ? formatGregorianCalendarLongUtc(iso) : formatGregorianCalendarDateUtc(iso);
  const shamsi = long ? formatShamsiOnlyLong(iso) : formatShamsiOnlyShort(iso);
  if (!greg || !shamsi) return primary;
  if (getCalendar() === 'GREGORIAN') return `${primary} (${shamsi})`;
  return `${primary} (${greg})`;
}

export function formatShamsiCalendarDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const primary =
    getCalendar() === 'GREGORIAN' ? formatGregorianCalendarDateUtc(iso) : formatShamsiOnlyShort(iso);
  if (!primary) return null;
  return withDualCalendar(iso, primary, false);
}

export function formatShamsiCalendarLong(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const primary =
    getCalendar() === 'GREGORIAN' ? formatGregorianCalendarLongUtc(iso) : formatShamsiOnlyLong(iso);
  if (!primary) return null;
  return withDualCalendar(iso, primary, true);
}

// ------- Timestamps (category b — user timezone via lib/datetime.ts) ----

export function formatShamsiTimestamp(iso: string | null | undefined): string | null {
  return formatTimestamp(iso);
}

export function formatShamsiTimestampDate(iso: string | null | undefined): string | null {
  return formatTimestampDate(iso);
}

export { getTimeFormat, resolveTimeZone } from './datetime';

// ------- Relative time (local-time, Persian locale) ---------------------

// Cached on first call per locale so we don't rebuild the Intl object on
// every format. v1.10: two locales — Persian under SHAMSI, English under
// GREGORIAN. The cache is keyed by locale string.
const _rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtfFor(locale: string): Intl.RelativeTimeFormat {
  let r = _rtfCache.get(locale);
  if (!r) {
    r = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    _rtfCache.set(locale, r);
  }
  return r;
}

// "۵ دقیقه پیش" / "دیروز" / "هفته آینده" etc. (or "5 minutes ago" / "yesterday"
// under Gregorian). Falls back to the full timestamp once the event is older
// than ~30 days, where relative wording stops being useful.
export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = then - Date.now();
  const absDays = Math.abs(diffMs) / (24 * 60 * 60 * 1000);
  if (absDays > 30) return formatShamsiTimestamp(iso);

  const locale = getCalendar() === 'GREGORIAN' ? 'en-US' : 'fa-IR';
  const rtf = rtfFor(locale);
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
