-- Add the new plannedDate column (team's target completion).
ALTER TABLE "Task" ADD COLUMN "plannedDate" TIMESTAMP(3);

-- Rename doneAt → completedAt. Postgres RENAME COLUMN preserves data + indexes.
ALTER TABLE "Task" RENAME COLUMN "doneAt" TO "completedAt";