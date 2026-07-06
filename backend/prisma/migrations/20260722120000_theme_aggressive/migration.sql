-- v2.5.43: add AGGRESSIVE (colourful dark theme) to ThemePreference (additive).
-- The new enum value is referenced only at runtime, never in this migration,
-- so adding it is safe on PostgreSQL 12+.

ALTER TYPE "ThemePreference" ADD VALUE IF NOT EXISTS 'AGGRESSIVE';
