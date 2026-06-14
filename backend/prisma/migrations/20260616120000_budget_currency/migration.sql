-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('IRR', 'EUR', 'USD');

-- AlterTable
ALTER TABLE "Team" ADD COLUMN "defaultCurrency" "Currency" NOT NULL DEFAULT 'IRR';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "budgetCurrency" "Currency" NOT NULL DEFAULT 'IRR';

-- Backfill existing projects from their team's default (all IRR on first deploy).
UPDATE "Project" p
SET "budgetCurrency" = t."defaultCurrency"
FROM "Team" t
WHERE p."teamId" = t."id";
