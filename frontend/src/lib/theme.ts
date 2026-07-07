// v1.61: multi-theme preference + CSS-variable token system.
// Stored preference may be SYSTEM (resolved at runtime); DOM carries the
// resolved palette as `theme-*` on <html>. Legacy `dark` class stays on
// dark-family themes so existing `dark:` Tailwind variants keep working.

export const THEME_PREFERENCES = [
  'LIGHT',
  'DARK',
  'SYSTEM',
  'MIDNIGHT',
  'SOLARIZED',
  'HIGH_CONTRAST',
  'NORD',
  'INDIGO',
  'VIBRANT',
  'SUNSET',
  'AGGRESSIVE',
  'OCEAN',
] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type ResolvedTheme = Exclude<ThemePreference, 'SYSTEM'>;

const STORAGE_KEY = 'taskhub.theme';

const THEME_CLASS_PREFIX = 'theme-';

const ALL_THEME_CLASSES = [
  'theme-light',
  'theme-dark',
  'theme-midnight',
  'theme-solarized',
  'theme-high-contrast',
  'theme-nord',
  'theme-indigo',
  'theme-vibrant',
  'theme-sunset',
  'theme-aggressive',
  'theme-ocean',
] as const;

/** Dark-family resolved themes get `<html class="dark">` for legacy `dark:` variants. */
export function isDarkFamily(resolved: ResolvedTheme): boolean {
  return (
    resolved === 'DARK' ||
    resolved === 'MIDNIGHT' ||
    resolved === 'NORD' ||
    resolved === 'AGGRESSIVE'
  );
}

export function resolvedThemeClass(resolved: ResolvedTheme): string {
  return THEME_CLASS_PREFIX + resolved.toLowerCase().replace(/_/g, '-');
}

export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  if (raw && (THEME_PREFERENCES as readonly string[]).includes(raw)) {
    return raw as ThemePreference;
  }
  return 'LIGHT';
}

export function resolveThemePreference(pref: ThemePreference): ResolvedTheme {
  if (pref === 'SYSTEM') {
    if (typeof window === 'undefined') return 'LIGHT';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'DARK' : 'LIGHT';
  }
  return pref;
}

function readInitial(): ThemePreference {
  if (typeof window === 'undefined') return 'LIGHT';
  return parseThemePreference(window.localStorage?.getItem(STORAGE_KEY));
}

let _active: ThemePreference = readInitial();
let _systemMql: MediaQueryList | null = null;
let _systemListener: ((e: MediaQueryListEvent) => void) | null = null;

function detachSystemListener(): void {
  if (_systemMql && _systemListener) {
    _systemMql.removeEventListener('change', _systemListener);
  }
  _systemMql = null;
  _systemListener = null;
}

function attachSystemListener(): void {
  if (typeof window === 'undefined') return;
  detachSystemListener();
  _systemMql = window.matchMedia('(prefers-color-scheme: dark)');
  _systemListener = () => {
    if (_active === 'SYSTEM') applyToDom(resolveThemePreference('SYSTEM'));
  };
  _systemMql.addEventListener('change', _systemListener);
}

export function applyToDom(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  const cls = el.classList;
  for (const c of ALL_THEME_CLASSES) cls.remove(c);
  cls.add(resolvedThemeClass(resolved));
  if (isDarkFamily(resolved)) cls.add('dark');
  else cls.remove('dark');
}

function applyPreference(pref: ThemePreference): void {
  applyToDom(resolveThemePreference(pref));
  if (pref === 'SYSTEM') attachSystemListener();
  else detachSystemListener();
}

applyPreference(_active);

/** @deprecated Use ThemePreference — kept for gradual migration. */
export type Theme = ThemePreference;

export function getThemePreference(): ThemePreference {
  return _active;
}

/** @deprecated Use getThemePreference */
export function getTheme(): ThemePreference {
  return _active;
}

export function setThemePreference(next: ThemePreference): boolean {
  const changed = _active !== next;
  _active = next;
  try {
    window.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // private-mode Safari
  }
  applyPreference(next);
  return changed;
}

/** @deprecated Use setThemePreference */
export function setTheme(next: ThemePreference): boolean {
  return setThemePreference(next);
}

export function adoptServerTheme(serverPref: ThemePreference | undefined | null): void {
  if (!serverPref) return;
  setThemePreference(serverPref);
}

/** Test / diagnostics hook — ensures no listener leak when leaving SYSTEM. */
export function hasSystemListenerAttached(): boolean {
  return _systemListener !== null;
}

/** Contrast ratio helper for HIGH_CONTRAST verification (WCAG). */
export function contrastRatio(foreground: string, background: string): number {
  const parse = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const lum = (r: number, g: number, b: number): number => {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [fr, fg, fb] = parse(foreground);
  const [br, bg, bb] = parse(background);
  const l1 = lum(fr, fg, fb);
  const l2 = lum(br, bg, bb);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export const HIGH_CONTRAST_TOKENS = {
  text: '#000000',
  bg: '#ffffff',
  textMuted: '#333333',
} as const;
