// v1.13: minimal in-app i18n. Same module-level + adopt pattern used by
// lib/calendar.ts and lib/theme.ts.
//
// EN is the canonical key source. FA covers the high-traffic surfaces
// (Dashboard, login, Settings shell, Preferences, About / Help corner
// buttons). Strings without an FA entry fall back to EN — explicitly
// chosen behaviour so adding a new English string doesn't crash the
// Persian UI.
//
// No React Context — components call `t(key)` from a hook that snapshots
// the current language. Re-render on toggle is via window.location.reload
// (same approach as the calendar toggle); avoids threading a context
// through every component.

import enMessages from '../i18n/en.json';
import faMessages from '../i18n/fa.json';

export type Language = 'EN' | 'FA';
export type MessageKey = keyof typeof enMessages;
type Catalogue = Record<string, string>;

const STORAGE_KEY = 'taskhub.language';
const CATALOGUES: Record<Language, Catalogue> = {
  EN: enMessages as Catalogue,
  FA: faMessages as Catalogue,
};

function readInitial(): Language {
  if (typeof window === 'undefined') return 'EN';
  const stored = window.localStorage?.getItem(STORAGE_KEY);
  return stored === 'FA' ? 'FA' : 'EN';
}

let _active: Language = readInitial();

function applyToDom(lang: Language): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang === 'FA' ? 'fa' : 'en';
  document.documentElement.dir = lang === 'FA' ? 'rtl' : 'ltr';
}

applyToDom(_active);

export function getLanguage(): Language {
  return _active;
}

export function setLanguage(next: Language): boolean {
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

export function adoptServerLanguage(serverPref: Language | undefined | null): void {
  if (!serverPref) return;
  setLanguage(serverPref);
}

// Translate a key. Falls back to EN if the FA catalogue is missing the
// entry; falls back to the key itself if EN is also missing (helps spot
// untranslated keys at QA time).
export function t(key: MessageKey | string): string {
  const en = CATALOGUES.EN[key];
  const cat = CATALOGUES[_active];
  return cat[key] ?? en ?? key;
}

// Tiny hook so call sites read as `const t = useT()`. No state — it
// returns the same `t` reference each render; language changes go
// through `setLanguage` + page reload.
export function useT(): (key: MessageKey | string) => string {
  return t;
}
