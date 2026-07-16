-- v2.5.58: project plan freeze. While "datesFrozen" is true, plan dates
-- (project start/end, task start/due/planned/baseline, subtask start/end)
-- are locked service-side with 403 PROJECT_DATES_FROZEN; reality capture
-- (completedAt, actualStart/actualEnd) stays open. Additive, idempotent.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "datesFrozen" BOOLEAN NOT NULL DEFAULT false;
