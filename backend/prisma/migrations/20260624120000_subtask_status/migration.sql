-- v1.82: subtask progress status (5-state). Additive — the `done` boolean is
-- kept and stays in sync (status DONE <-> done true) so the checkbox + the
-- "X of Y done" rollup keep working.

CREATE TYPE "SubtaskStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'WAITING', 'DEFERRED', 'DONE');

ALTER TABLE "Subtask" ADD COLUMN "status" "SubtaskStatus" NOT NULL DEFAULT 'NOT_STARTED';

-- Backfill so every existing row has a coherent status: done -> DONE; the rest
-- keep the NOT_STARTED default.
UPDATE "Subtask" SET "status" = 'DONE' WHERE "done" = true;

CREATE INDEX "Subtask_taskId_status_idx" ON "Subtask" ("taskId", "status");
