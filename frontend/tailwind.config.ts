import type { Config } from 'tailwindcss';

const config: Config = {
  // v1.13: class-based dark mode. lib/theme.ts toggles
  // <html class="dark"> from the per-user preference + localStorage.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};

export default config;
