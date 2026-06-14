-- v1.61: extend ThemePreference with SYSTEM + named palettes (additive).

ALTER TYPE "ThemePreference" ADD VALUE IF NOT EXISTS 'SYSTEM';
ALTER TYPE "ThemePreference" ADD VALUE IF NOT EXISTS 'MIDNIGHT';
ALTER TYPE "ThemePreference" ADD VALUE IF NOT EXISTS 'SOLARIZED';
ALTER TYPE "ThemePreference" ADD VALUE IF NOT EXISTS 'HIGH_CONTRAST';
ALTER TYPE "ThemePreference" ADD VALUE IF NOT EXISTS 'NORD';
