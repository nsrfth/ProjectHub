-- Phase 3A: denormalize teamId onto Activity, make taskId + actorId nullable
-- so future emitters (directory, SCIM, 2FA, webhook, token, recurring) can
-- write audit rows without a task. Add indexes for the audit-log viewer's
-- common access patterns.

-- 1. Loosen NOT NULL on taskId / actorId.
ALTER TABLE "Activity" ALTER COLUMN "taskId" DROP NOT NULL;
ALTER TABLE "Activity" ALTER COLUMN "actorId" DROP NOT NULL;

-- 2. Add the denormalized teamId column.
ALTER TABLE "Activity" ADD COLUMN "teamId" TEXT;

-- 3. Backfill teamId from the task's team for existing rows. Single UPDATE
--    — Postgres handles it in one pass; no temp tables needed.
UPDATE "Activity"
SET "teamId" = "Task"."teamId"
FROM "Task"
WHERE "Activity"."taskId" = "Task"."id";

-- 4. Swap the actor FK from CASCADE → SET NULL so deleting a user preserves
--    their audit trail. The actor relation becomes optional.
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_actorId_fkey";
ALTER TABLE "Activity"
    ADD CONSTRAINT "Activity_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. Add the team FK (cascade — deleting a team can wipe its audit log).
ALTER TABLE "Activity"
    ADD CONSTRAINT "Activity_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. New indexes for the viewer query paths.
CREATE INDEX "Activity_teamId_createdAt_idx" ON "Activity"("teamId", "createdAt");
CREATE INDEX "Activity_actorId_createdAt_idx" ON "Activity"("actorId", "createdAt");
CREATE INDEX "Activity_action_createdAt_idx" ON "Activity"("action", "createdAt");
