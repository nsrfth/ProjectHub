import type { ThemePreference } from '@/lib/theme';
import { THEME_PREFERENCES } from '@/lib/theme';
import { useT } from '@/lib/i18n';

const SWATCH: Record<ThemePreference, { bg: string; surface: string; text: string; primary: string }> = {
  LIGHT: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', primary: '#6366f1' },
  DARK: { bg: '#020617', surface: '#1e293b', text: '#f1f5f9', primary: '#818cf8' },
  SYSTEM: { bg: 'linear-gradient(135deg, #f8fafc 50%, #020617 50%)', surface: '#94a3b8', text: '#334155', primary: '#6366f1' },
  MIDNIGHT: { bg: '#0a0e1a', surface: '#1a2236', text: '#e2e8f0', primary: '#6366f1' },
  SOLARIZED: { bg: '#fdf6e3', surface: '#eee8d5', text: '#073642', primary: '#268bd2' },
  HIGH_CONTRAST: { bg: '#ffffff', surface: '#000000', text: '#000000', primary: '#0000ee' },
  NORD: { bg: '#2e3440', surface: '#434c5e', text: '#eceff4', primary: '#88c0d0' },
  INDIGO: { bg: '#f6f6fd', surface: '#ffffff', text: '#1e1b3a', primary: '#5558e3' },
  VIBRANT: { bg: '#fef7ff', surface: '#ffffff', text: '#2a1a3a', primary: '#7c3aed' },
  SUNSET: { bg: '#fff8f3', surface: '#ffffff', text: '#3a1f1a', primary: '#c2410c' },
  AGGRESSIVE: { bg: '#0d0a0a', surface: '#1f1414', text: '#f5e6e6', primary: '#e11d48' },
  OCEAN: { bg: '#f2f5f9', surface: '#ffffff', text: '#0f2138', primary: '#1d4ed8' },
};

const LABEL_KEY: Record<ThemePreference, string> = {
  LIGHT: 'preferences.theme.light',
  DARK: 'preferences.theme.dark',
  SYSTEM: 'preferences.theme.system',
  MIDNIGHT: 'preferences.theme.midnight',
  SOLARIZED: 'preferences.theme.solarized',
  HIGH_CONTRAST: 'preferences.theme.highContrast',
  NORD: 'preferences.theme.nord',
  INDIGO: 'preferences.theme.indigo',
  VIBRANT: 'preferences.theme.vibrant',
  SUNSET: 'preferences.theme.sunset',
  AGGRESSIVE: 'preferences.theme.aggressive',
  OCEAN: 'preferences.theme.ocean',
};

interface ThemePickerProps {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}

export default function ThemePicker({ value, onChange }: ThemePickerProps): JSX.Element {
  const t = useT();

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">{t('preferences.theme.systemHint')}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {THEME_PREFERENCES.map((pref) => {
          const sw = SWATCH[pref];
          const selected = value === pref;
          return (
            <button
              key={pref}
              type="button"
              onClick={() => onChange(pref)}
              className={[
                'rounded-lg border p-2 text-start transition-colors',
                selected ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/50',
              ].join(' ')}
              aria-pressed={selected}
            >
              <div
                className="h-10 rounded mb-2 border border-border overflow-hidden flex"
                style={{
                  background: pref === 'SYSTEM' ? sw.bg : sw.bg,
                }}
              >
                <span className="flex-1" style={{ background: pref === 'SYSTEM' ? '#f8fafc' : sw.surface }} />
                <span className="w-3" style={{ background: sw.primary }} />
              </div>
              <span className="text-sm font-medium text-text block">{t(LABEL_KEY[pref])}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
