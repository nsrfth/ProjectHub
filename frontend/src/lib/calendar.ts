// v1.10: per-user display calendar.
//
// The active calendar is module-level state, seeded from localStorage at
// load and updated by `setCalendar` (which also writes to localStorage).
// Formatters in lib/shamsi.ts read this value on every call and branch
// between Shamsi (Jalali) and Gregorian output.
//
// Components do NOT re-render automatically when the active calendar
// changes — the Preferences page reloads the window after a successful
// PATCH so every rendered formatter / picker picks up the new value
// cleanly. This sidesteps threading the preference through every helper
// signature or wrapping every component in a CalendarContext.

export type Calendar = 'SHAMSI' | 'GREGORIAN';

// v1.11: instance-wide off-days. An array of weekday IDs (0=Sun..6=Sat —
// JS Date.getUTCDay convention). Default [0,6] (Sat+Sun). Admins pick any
// subset via Settings → Preferences; stored as an InstanceSetting on the
// server. The frontend caches a local copy here so isWeekend() /
// getWeekendDays() stay synchronous (no React state, no per-render fetch).

const STORAGE_KEY = 'taskhub.calendar';
const WEEKEND_STORAGE_KEY = 'taskhub.weekend';

function readInitial(): Calendar {
  if (typeof window === 'undefined') return 'SHAMSI';
  const stored = window.localStorage?.getItem(STORAGE_KEY);
  return stored === 'GREGORIAN' ? 'GREGORIAN' : 'SHAMSI';
}

let _active: Calendar = readInitial();

export function getCalendar(): Calendar {
  return _active;
}

// Set the active calendar + persist. Returns true if the value changed
// (useful when deciding whether to trigger a window reload).
export function setCalendar(next: Calendar): boolean {
  const changed = _active !== next;
  _active = next;
  try {
    window.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // localStorage can throw in private-mode Safari; the runtime state
    // still updates so the active session keeps working.
  }
  return changed;
}

// Sync from the server-side per-user preference. Called by AuthContext
// after login / refresh so a user logging in on a fresh device sees their
// chosen calendar immediately, without first toggling locally.
export function adoptServerCalendar(serverPref: Calendar | undefined | null): void {
  if (!serverPref) return;
  setCalendar(serverPref);
}

// ── Off-days ─────────────────────────────────────────────────────────────

// Normalise an unknown into a sorted unique int[] in [0..6]. Used both at
// storage-read time (where the JSON might be anything) and at adopt time
// (where the server response is already validated, but defensive coding
// is cheap).
function sanitiseDays(input: unknown): number[] {
  if (!Array.isArray(input)) return [0, 6];
  const cleaned = input
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return [...new Set(cleaned)].sort((a, b) => a - b);
}

function readInitialWeekendDays(): number[] {
  if (typeof window === 'undefined') return [0, 6];
  const stored = window.localStorage?.getItem(WEEKEND_STORAGE_KEY);
  if (!stored) return [0, 6];
  try {
    return sanitiseDays(JSON.parse(stored));
  } catch {
    return [0, 6];
  }
}

let _weekendDays: number[] = readInitialWeekendDays();

// Active off-day set. Returns a defensive copy so callers can't mutate it.
export function getWeekendDays(): number[] {
  return _weekendDays.slice();
}

// Replace the active off-day set. Returns true when the value changed
// (useful for deciding whether to trigger a reload after the admin
// updates the workweek).
export function setWeekendDays(next: number[]): boolean {
  const sanitised = sanitiseDays(next);
  const changed = JSON.stringify(sanitised) !== JSON.stringify(_weekendDays);
  _weekendDays = sanitised;
  try {
    window.localStorage?.setItem(WEEKEND_STORAGE_KEY, JSON.stringify(sanitised));
  } catch {
    // localStorage can throw in private-mode Safari; runtime state holds.
  }
  return changed;
}

// Adopt the value the server returned from /system/info. Called once at
// app start so the very first picker render already paints the right
// weekend cells.
export function adoptServerWeekend(serverPref: number[] | undefined | null): void {
  if (!serverPref) return;
  setWeekendDays(serverPref);
}

// True iff `date`'s weekday is in the configured off-day set.
export function isWeekend(date: Date): boolean {
  return _weekendDays.includes(date.getUTCDay());
}
