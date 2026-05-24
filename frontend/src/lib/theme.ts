// v1.13: per-user theme. Same module-level pattern as lib/calendar.ts —
// the active value is seeded from localStorage at module load and applied
// to <html class="dark"> at every change. Components don't need to
// subscribe; Tailwind's `dark:` variants react to the class change
// without a re-render.

export type Theme = 'LIGHT' | 'DARK';

const STORAGE_KEY = 'taskhub.theme';

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'LIGHT';
  const stored = window.localStorage?.getItem(STORAGE_KEY);
  return stored === 'DARK' ? 'DARK' : 'LIGHT';
}

let _active: Theme = readInitial();

function applyToDom(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const cls = document.documentElement.classList;
  if (theme === 'DARK') cls.add('dark');
  else cls.remove('dark');
}

// Apply once at module load so a page reload restores the theme before
// the first paint. The CSS class is already on <html> from the inline
// bootstrap in index.html (set there to avoid the FOUC), so this is a
// safety net for tools that bypass that path.
applyToDom(_active);

export function getTheme(): Theme {
  return _active;
}

export function setTheme(next: Theme): boolean {
  const changed = _active !== next;
  _active = next;
  try {
    window.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // localStorage may throw in private-mode Safari — runtime state holds.
  }
  applyToDom(next);
  return changed;
}

// Adopt from the server. Called by AuthContext on every signed-in entry
// point so a user logging in on a new device sees their chosen theme.
export function adoptServerTheme(serverPref: Theme | undefined | null): void {
  if (!serverPref) return;
  setTheme(serverPref);
}
