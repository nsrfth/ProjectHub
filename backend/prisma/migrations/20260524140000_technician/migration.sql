-- v1.19: "Assigned Technician" field on Task + Subtask. Distinct from
-- assignee/creator; defaults to the creator at creation time. Only team
-- MANAGERS / global ADMINs can change it post-create (enforced in the
-- service layer). SET NULL on user delete so deletions don't cascade.

-- Task
ALTER TABLE "Task" ADD COLUMN "technicianId" TEXT;
CREATE INDEX "Task_teamId_technicianId_idx" ON "Task"("teamId", "technicianId");
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: existing tasks get the creator as technician where the creator
-- still exists. Tasks whose creator was already deleted (NULL) keep NULL.
UPDATE "Task" SET "technicianId" = "creatorId" WHERE "creatorId" IS NOT NULL;

-- Subtask
ALTER TABLE "Subtask" ADD COLUMN "technicianId" TEXT;
CREATE INDEX "Subtask_technicianId_idx" ON "Subtask"("technicianId");
ALTER TABLE "Subtask"
  ADD CONSTRAINT "Subtask_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: existing subtasks inherit the parent task's technician (which we
-- just set above). Anything still NULL stays NULL.
UPDATE "Subtask" s
SET "technicianId" = t."technicianId"
FROM "Task" t
WHERE s."taskId" = t.id AND t."technicianId" IS NOT NULL;
