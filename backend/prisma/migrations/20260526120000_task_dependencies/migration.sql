-- v1.29: task dependencies.
--
-- A new TaskDependency edge table + a new DependencyType enum + a new
-- NotifyType enum value for the "unblocked" notification. Additive only —
-- no existing data is touched.

-- 1. New enum for the edge kind.
CREATE TYPE "DependencyType" AS ENUM ('FINISH_TO_START', 'RELATES_TO');

-- 2. New NotifyType value — Postgres 12+ allows ADD VALUE inside a tx, so
--    no special non-transactional handling needed. Placed last to keep the
--    chronological order of the enum.
ALTER TYPE "NotifyType" ADD VALUE 'TASK_UNBLOCKED';

-- 3. Edge table. taskId = blocked task; dependsOnId = blocker. Cascade on
--    both FKs so deleting either task tears its edges down with it.
CREATE TABLE "TaskDependency" (
  "id"          TEXT NOT NULL,
  "teamId"      TEXT NOT NULL,
  "taskId"      TEXT NOT NULL,
  "dependsOnId" TEXT NOT NULL,
  "type"        "DependencyType" NOT NULL DEFAULT 'FINISH_TO_START',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("id")
);

-- Unique edge: at most one row per (taskId, dependsOnId). Lets the service
-- layer treat a re-add as a no-op rather than a duplicate.
CREATE UNIQUE INDEX "TaskDependency_taskId_dependsOnId_key"
  ON "TaskDependency"("taskId", "dependsOnId");

-- teamId scoping index — every list query filters by it.
CREATE INDEX "TaskDependency_teamId_idx" ON "TaskDependency"("teamId");

-- dependsOnId index for the "find all tasks blocked by X" path the
-- unblock-notification logic uses when a task transitions to DONE.
CREATE INDEX "TaskDependency_dependsOnId_idx" ON "TaskDependency"("dependsOnId");

ALTER TABLE "TaskDependency"
  ADD CONSTRAINT "TaskDependency_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskDependency"
  ADD CONSTRAINT "TaskDependency_dependsOnId_fkey"
  FOREIGN KEY ("dependsOnId") REFERENCES "Task"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. RBAC backfill: grant the new `task.manage_dependencies` permission to
--    every existing system Manager role (v1.23 backfill convention). Member
--    role does NOT get it by default — managing dependencies is a curator's
--    job. Admins always bypass via the global ADMIN check.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'task.manage_dependencies'
FROM "Role" r
WHERE r."name" = 'Manager' AND r."isSystem" = true
ON CONFLICT DO NOTHING;
