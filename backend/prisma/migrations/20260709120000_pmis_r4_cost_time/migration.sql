-- v2.0 (PMIS R4 - cost control + time tracking). Two profile-gated modules:
-- timesheets (RateCard, TimesheetPeriod, TimeEntry) and cost_control
-- (CostAccount, BudgetLine, Commitment, Expense, ActualCostEntry ledger).
-- Money stored as integer minor units (BIGINT). Additive: existing projects
-- with a plannedBudget get a DEFAULT cost account + one MIGRATED budget line;
-- identity FX rows (rate 1.0) are seeded; Manager roles get the new perms.

-- CreateEnum
CREATE TYPE "RateScope" AS ENUM ('USER', 'ROLE');
CREATE TYPE "TimesheetStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REOPENED');
CREATE TYPE "BudgetLineSource" AS ENUM ('MIGRATED', 'MANUAL');
CREATE TYPE "CommitmentStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');
CREATE TYPE "CostEntrySource" AS ENUM ('TIMESHEET', 'EXPENSE', 'INVOICE', 'MANUAL');
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "RateCard" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "scope" "RateScope" NOT NULL,
    "userId" TEXT,
    "role" "TeamRole",
    "costRateMinor" BIGINT NOT NULL,
    "billRateMinor" BIGINT,
    "currency" "Currency" NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RateCard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TimesheetPeriod" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "TimesheetStatus" NOT NULL DEFAULT 'OPEN',
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TimesheetPeriod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "periodId" TEXT,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "costRateMinorSnapshot" BIGINT,
    "currencySnapshot" "Currency",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CostAccount" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CostAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BudgetLine" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "costAccountId" TEXT NOT NULL,
    "taskId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "source" "BudgetLineSource" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Commitment" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "costAccountId" TEXT,
    "vendorName" TEXT,
    "reference" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "status" "CommitmentStatus" NOT NULL DEFAULT 'OPEN',
    "procurementRefId" TEXT,
    "incurredOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Commitment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "costAccountId" TEXT,
    "taskId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "incurredOn" DATE NOT NULL,
    "submittedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActualCostEntry" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "costAccountId" TEXT,
    "taskId" TEXT,
    "source" "CostEntrySource" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "baseAmountMinor" BIGINT NOT NULL,
    "baseCurrency" "Currency" NOT NULL,
    "fxRateId" TEXT,
    "incurredOn" DATE NOT NULL,
    "description" TEXT,
    "reversalOfId" TEXT,
    "sourceTimeEntryId" TEXT,
    "sourceExpenseId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActualCostEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateCard_teamId_scope_idx" ON "RateCard"("teamId", "scope");
CREATE INDEX "RateCard_userId_idx" ON "RateCard"("userId");

CREATE UNIQUE INDEX "TimesheetPeriod_userId_periodStart_key" ON "TimesheetPeriod"("userId", "periodStart");
CREATE INDEX "TimesheetPeriod_teamId_userId_idx" ON "TimesheetPeriod"("teamId", "userId");
CREATE INDEX "TimesheetPeriod_status_idx" ON "TimesheetPeriod"("status");

CREATE INDEX "TimeEntry_teamId_projectId_idx" ON "TimeEntry"("teamId", "projectId");
CREATE INDEX "TimeEntry_userId_date_idx" ON "TimeEntry"("userId", "date");
CREATE INDEX "TimeEntry_periodId_idx" ON "TimeEntry"("periodId");
CREATE INDEX "TimeEntry_taskId_idx" ON "TimeEntry"("taskId");

CREATE UNIQUE INDEX "CostAccount_projectId_code_key" ON "CostAccount"("projectId", "code");
CREATE INDEX "CostAccount_teamId_idx" ON "CostAccount"("teamId");
CREATE INDEX "CostAccount_projectId_idx" ON "CostAccount"("projectId");
CREATE INDEX "CostAccount_parentId_idx" ON "CostAccount"("parentId");

CREATE INDEX "BudgetLine_projectId_idx" ON "BudgetLine"("projectId");
CREATE INDEX "BudgetLine_costAccountId_idx" ON "BudgetLine"("costAccountId");
CREATE INDEX "BudgetLine_teamId_currency_idx" ON "BudgetLine"("teamId", "currency");

CREATE INDEX "Commitment_projectId_idx" ON "Commitment"("projectId");
CREATE INDEX "Commitment_costAccountId_idx" ON "Commitment"("costAccountId");
CREATE INDEX "Commitment_status_idx" ON "Commitment"("status");

CREATE INDEX "Expense_projectId_idx" ON "Expense"("projectId");
CREATE INDEX "Expense_status_idx" ON "Expense"("status");
CREATE INDEX "Expense_costAccountId_idx" ON "Expense"("costAccountId");

CREATE INDEX "ActualCostEntry_projectId_idx" ON "ActualCostEntry"("projectId");
CREATE INDEX "ActualCostEntry_costAccountId_idx" ON "ActualCostEntry"("costAccountId");
CREATE INDEX "ActualCostEntry_teamId_incurredOn_idx" ON "ActualCostEntry"("teamId", "incurredOn");
CREATE INDEX "ActualCostEntry_source_idx" ON "ActualCostEntry"("source");
CREATE INDEX "ActualCostEntry_taskId_idx" ON "ActualCostEntry"("taskId");

-- AddForeignKey
ALTER TABLE "RateCard" ADD CONSTRAINT "RateCard_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RateCard" ADD CONSTRAINT "RateCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimesheetPeriod" ADD CONSTRAINT "TimesheetPeriod_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimesheetPeriod" ADD CONSTRAINT "TimesheetPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "TimesheetPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CostAccount" ADD CONSTRAINT "CostAccount_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostAccount" ADD CONSTRAINT "CostAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostAccount" ADD CONSTRAINT "CostAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CostAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_costAccountId_fkey" FOREIGN KEY ("costAccountId") REFERENCES "CostAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_costAccountId_fkey" FOREIGN KEY ("costAccountId") REFERENCES "CostAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_costAccountId_fkey" FOREIGN KEY ("costAccountId") REFERENCES "CostAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_costAccountId_fkey" FOREIGN KEY ("costAccountId") REFERENCES "CostAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "ActualCostEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: a DEFAULT cost account + one MIGRATED budget line per project that
-- has a legacy plannedBudget. Minor units = plannedBudget * 10^decimals (IRR=0,
-- EUR/USD=2). Projects without a plannedBudget get a DEFAULT account lazily on
-- first cost use (ensureDefaultCostAccount), so none is created here.
INSERT INTO "CostAccount" ("id", "teamId", "projectId", "code", "name", "path", "isDefault", "updatedAt")
SELECT gen_random_uuid()::text, p."teamId", p."id", 'DEFAULT', 'Default', 'pending', true, CURRENT_TIMESTAMP
FROM "Project" p
WHERE p."plannedBudget" IS NOT NULL;

UPDATE "CostAccount" SET "path" = '/' || "id" WHERE "path" = 'pending';

INSERT INTO "BudgetLine" ("id", "teamId", "projectId", "costAccountId", "amountMinor", "currency", "source", "updatedAt")
SELECT gen_random_uuid()::text, ca."teamId", ca."projectId", ca."id",
       ROUND(p."plannedBudget" * (CASE p."budgetCurrency" WHEN 'IRR' THEN 1 ELSE 100 END))::bigint,
       p."budgetCurrency", 'MIGRATED', CURRENT_TIMESTAMP
FROM "CostAccount" ca
JOIN "Project" p ON p."id" = ca."projectId"
WHERE ca."isDefault" = true AND p."plannedBudget" IS NOT NULL;

-- Seed identity FX rows (1 unit = 1 unit) so same-currency conversion is a
-- no-op and cross-currency conversion has a deterministic base to extend.
INSERT INTO "FxRate" ("id", "baseCurrency", "quoteCurrency", "rate", "asOf", "source")
VALUES
  (gen_random_uuid()::text, 'IRR', 'IRR', 1, DATE '2000-01-01', 'identity'),
  (gen_random_uuid()::text, 'EUR', 'EUR', 1, DATE '2000-01-01', 'identity'),
  (gen_random_uuid()::text, 'USD', 'USD', 1, DATE '2000-01-01', 'identity')
ON CONFLICT ("baseCurrency", "quoteCurrency", "asOf") DO NOTHING;

-- RBAC backfill: grant the R4 permission keys to every existing system Manager
-- role (v1.23 convention; new teams pick these up via ensureSystemRoles ->
-- DEFAULT_MANAGER_PERMISSIONS). Idempotent.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", p.perm
FROM "Role" r
CROSS JOIN (VALUES
  ('cost.manage'),
  ('timesheet.approve'),
  ('timesheet.manage_rates')
) AS p(perm)
WHERE r."name" = 'Manager' AND r."isSystem" = true
ON CONFLICT DO NOTHING;
