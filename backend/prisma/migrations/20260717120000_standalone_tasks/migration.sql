-- v2.5.28: StandaloneTask (Option C) — personal tasks isolated from projects.
-- Additive only: a new enum + table, a new NotifyType value, and Notification.teamId
-- made nullable (personal-task notifications have no team). No existing table's
-- columns/constraints change beyond that nullable relax; no data migration.

-- Personal task lifecycle (own enum, separate from TaskStatus by design).
CREATE TYPE "StandaloneTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');

-- Due-reminder notification type for personal tasks (additive).
ALTER TYPE "NotifyType" ADD VALUE IF NOT EXISTS 'STANDALONE_TASK_DUE';

-- Personal-task notifications carry no team → relax the NOT NULL.
ALTER TABLE "Notification" ALTER COLUMN "teamId" DROP NOT NULL;

CREATE TABLE "StandaloneTask" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "StandaloneTaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "TaskPriority",
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "lastDueNotifiedAt" TIMESTAMP(3),
    "promotedTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "StandaloneTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StandaloneTask_ownerId_deletedAt_status_sortOrder_idx"
    ON "StandaloneTask"("ownerId", "deletedAt", "status", "sortOrder");
CREATE INDEX "StandaloneTask_ownerId_dueDate_idx"
    ON "StandaloneTask"("ownerId", "dueDate");

ALTER TABLE "StandaloneTask" ADD CONSTRAINT "StandaloneTask_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
