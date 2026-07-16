import type { Config } from 'tailwindcss';

const config: Config = {
  // v1.13+: class-based dark mode for legacy `dark:` variants. lib/theme.ts
  // toggles `dark` on dark-family resolved themes (DARK, MIDNIGHT, NORD,
  // SYSTEM→dark). Named palettes also set `theme-*` + CSS variables.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        'bg-elevated': 'var(--color-bg-elevated)',
        surface: 'var(--color-surface)',
        border: 'var(--color-border)',
        text: 'var(--color-text)',
        'text-muted': 'var(--color-text-muted)',
        primary: 'var(--color-primary)',
        'primary-contrast': 'var(--color-primary-contrast)',
        // v2.5.57 derived interaction tokens — see styles/themes.css.
        'surface-hover': 'var(--color-surface-hover)',
        'primary-hover': 'var(--color-primary-hover)',
        'primary-soft': 'var(--color-primary-soft)',
        ring: 'var(--color-ring)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',
        accent: 'var(--color-accent)',
        // Off-day (weekend/holiday) cell tint — see styles/themes.css.
        offday: 'var(--color-offday)',
      },
    },
  },
  plugins: [],
};

export default config;
