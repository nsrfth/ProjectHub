import { z } from 'zod';

export const THEME_PREFERENCE_VALUES = [
  'LIGHT',
  'DARK',
  'SYSTEM',
  'MIDNIGHT',
  'SOLARIZED',
  'HIGH_CONTRAST',
  'NORD',
] as const;

export const themePreferenceEnum = z.enum(THEME_PREFERENCE_VALUES);

export type ThemePreferenceValue = z.infer<typeof themePreferenceEnum>;
