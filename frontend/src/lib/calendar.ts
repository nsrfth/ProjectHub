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

const STORAGE_KEY = 'taskhub.calendar';

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
