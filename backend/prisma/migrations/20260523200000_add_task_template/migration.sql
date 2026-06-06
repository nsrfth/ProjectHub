-- Phase 4: recurring tasks. TaskTemplate defines a recurrence rule attached
-- to a source Task; spawned Tasks point back via spawnedFromTemplateId.

CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

CREATE TABLE "TaskTemplate" (
    "id" TEXT NOT NULL,
    "sourceTaskId" TEXT NOT NULL,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "byWeekday" INTEGER[],
    "startsOn" TIMESTAMP(3) NOT NULL,
    "endsOn" TIMESTAMP(3),
    "maxCount" INTEGER,
    "dueOffsetDays" INTEGER,
    "plannedOffsetDays" INTEGER,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "spawnedCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TaskTemplate_sourceTaskId_key" ON "TaskTemplate"("sourceTaskId");
CREATE INDEX "TaskTemplate_active_nextRunAt_idx" ON "TaskTemplate"("active", "nextRunAt");

ALTER TABLE "TaskTemplate"
    ADD CONSTRAINT "TaskTemplate_sourceTaskId_fkey"
    FOREIGN KEY ("sourceTaskId") REFERENCES "Task"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Spawned-task linkage. (templateId, period) is unique so a retried tick
-- can't insert a second copy for the same period.
ALTER TABLE "Task" ADD COLUMN "spawnedFromTemplateId" TEXT;
ALTER TABLE "Task" ADD COLUMN "spawnedForPeriod" TEXT;

CREATE UNIQUE INDEX "Task_spawnedFromTemplateId_spawnedForPeriod_key"
    ON "Task"("spawnedFromTemplateId", "spawnedForPeriod");

ALTER TABLE "Task"
    ADD CONSTRAINT "Task_spawnedFromTemplateId_fkey"
    FOREIGN KEY ("spawnedFromTemplateId") REFERENCES "TaskTemplate"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
