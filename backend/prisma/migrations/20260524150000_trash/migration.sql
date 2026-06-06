-- v1.21: soft-delete (trash) for Task + Comment. Hard-deleting either now
-- becomes a flip of deletedAt + deletedById; read paths filter on
-- deletedAt IS NULL. Restore = clear deletedAt. Purge = real DELETE.

-- Task
ALTER TABLE "Task" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Task_teamId_deletedAt_idx" ON "Task"("teamId", "deletedAt");
ALTER TABLE "Task"
  ADD CONSTRAINT "Task_deletedById_fkey"
  FOREIGN KEY ("deletedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Comment
ALTER TABLE "Comment" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Comment" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "Comment_taskId_deletedAt_idx" ON "Comment"("taskId", "deletedAt");
ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_deletedById_fkey"
  FOREIGN KEY ("deletedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
