import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../i18n/en.json';
import fa from '../i18n/fa.json';
import type { ResolvedTheme, ThemePreference } from './theme';

export const THEME_I18N_KEYS = [
  'preferences.theme.title',
  'preferences.theme.light',
  'preferences.theme.dark',
  'preferences.theme.system',
  'preferences.theme.midnight',
  'preferences.theme.solarized',
  'preferences.theme.highContrast',
  'preferences.theme.nord',
  'preferences.theme.systemHint',
] as const;

function createClassList(): { add: (...tokens: string[]) => void; remove: (...tokens: string[]) => void; contains: (token: string) => boolean } {
  const set = new Set<string>();
  return {
    add: (...tokens: string[]) => tokens.forEach((t) => set.add(t)),
    remove: (...tokens: string[]) => tokens.forEach((t) => set.delete(t)),
    contains: (token: string) => set.has(token),
  };
}

function mockMatchMedia(dark: boolean): MediaQueryList {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  return {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    },
    dispatchEvent: () => true,
    addListener: () => undefined,
    removeListener: () => undefined,
  } as MediaQueryList;
}

function installDom(osDark = false): void {
  const classList = createClassList();
  const store: Record<string, string> = {};
  const storage = {
    getItem(key: string) { return store[key] ?? null; },
    setItem(key: string, val: string) { store[key] = val; },
    removeItem(key: string) { delete store[key]; },
    clear() { for (const k of Object.keys(store)) delete store[k]; },
  };
  const matchMediaFn = (query: string) =>
    query === '(prefers-color-scheme: dark)' ? mockMatchMedia(osDark) : mockMatchMedia(false);
  vi.stubGlobal('document', {
    documentElement: { classList },
  });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('matchMedia', matchMediaFn);
  vi.stubGlobal('window', {
    localStorage: storage,
    matchMedia: matchMediaFn,
  });
}

async function loadTheme(osDark = false) {
  vi.resetModules();
  installDom(osDark);
  return import('./theme');
}

describe('theme preference runtime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('1) each preference resolves to a concrete theme class on the DOM', async () => {
    const theme = await loadTheme(false);
    const expected: Record<ThemePreference, ResolvedTheme> = {
      LIGHT: 'LIGHT',
      DARK: 'DARK',
      SYSTEM: 'LIGHT',
      MIDNIGHT: 'MIDNIGHT',
      SOLARIZED: 'SOLARIZED',
      HIGH_CONTRAST: 'HIGH_CONTRAST',
      NORD: 'NORD',
      INDIGO: 'INDIGO',
      VIBRANT: 'VIBRANT',
      SUNSET: 'SUNSET',
      AGGRESSIVE: 'AGGRESSIVE',
    };
    for (const pref of theme.THEME_PREFERENCES) {
      theme.applyToDom(theme.resolveThemePreference(pref));
      const resolved = expected[pref];
      expect(document.documentElement.classList.contains(theme.resolvedThemeClass(resolved))).toBe(true);
    }
  });

  it('2) SYSTEM follows OS dark preference', async () => {
    const theme = await loadTheme(true);
    expect(theme.resolveThemePreference('SYSTEM')).toBe('DARK');
    theme.setThemePreference('SYSTEM');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('5) HIGH_CONTRAST text/background pairs meet WCAG AA (≥ 4.5:1)', async () => {
    const theme = await loadTheme(false);
    expect(theme.contrastRatio(theme.HIGH_CONTRAST_TOKENS.text, theme.HIGH_CONTRAST_TOKENS.bg)).toBeGreaterThanOrEqual(4.5);
    expect(theme.contrastRatio(theme.HIGH_CONTRAST_TOKENS.textMuted, theme.HIGH_CONTRAST_TOKENS.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('6) LIGHT and DARK keep legacy class names (no regression)', async () => {
    const theme = await loadTheme(false);
    theme.applyToDom('LIGHT');
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    theme.applyToDom('DARK');
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('7) dark-family themes add legacy dark class for Tailwind dark: variants', async () => {
    const theme = await loadTheme(false);
    for (const resolved of ['DARK', 'MIDNIGHT', 'NORD', 'AGGRESSIVE'] as const) {
      theme.applyToDom(resolved);
      expect(theme.isDarkFamily(resolved)).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    }
    theme.applyToDom('SOLARIZED');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('9) switching away from SYSTEM detaches matchMedia listener (no leak)', async () => {
    const theme = await loadTheme(false);
    theme.setThemePreference('SYSTEM');
    expect(theme.hasSystemListenerAttached()).toBe(true);
    theme.setThemePreference('MIDNIGHT');
    expect(theme.hasSystemListenerAttached()).toBe(false);
    theme.setThemePreference('SYSTEM');
    expect(theme.hasSystemListenerAttached()).toBe(true);
    theme.setThemePreference('LIGHT');
    expect(theme.hasSystemListenerAttached()).toBe(false);
  });

  it('10) theme i18n keys exist in EN and FA (RTL catalogue)', () => {
    for (const key of THEME_I18N_KEYS) {
      expect(en[key as keyof typeof en], `en missing ${key}`).toBeTruthy();
      expect(fa[key as keyof typeof fa], `fa missing ${key}`).toBeTruthy();
    }
  });

  it('parseThemePreference falls back to LIGHT for unknown values', async () => {
    const theme = await loadTheme(false);
    expect(theme.parseThemePreference('PLAID')).toBe('LIGHT');
    expect(theme.parseThemePreference(null)).toBe('LIGHT');
  });
});
