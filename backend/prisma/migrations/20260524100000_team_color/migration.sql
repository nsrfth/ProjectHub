-- v1.12: per-team accent colour. Hex like '#3b82f6'; null = use default.
ALTER TABLE "Team" ADD COLUMN "color" TEXT;
