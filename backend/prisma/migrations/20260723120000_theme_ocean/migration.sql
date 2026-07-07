-- v2.5.48: add OCEAN (product-palette light theme) to ThemePreference (additive).
-- The new enum value is referenced only at runtime, never in this migration,
-- so adding it is safe on PostgreSQL 12+.

ALTER TYPE "ThemePreference" ADD VALUE IF NOT EXISTS 'OCEAN';
