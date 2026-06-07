-- v1.37: Task.startDate (nullable, UTC midnight).
--
-- The fourth date concept on Task, parallel to dueDate / plannedDate /
-- completedAt. Informational for now — no scheduler reads it, no report
-- aggregates against it, and the calendar feed deliberately doesn't
-- include it (deferred to keep the grid uncluttered). The v1.18
-- manager-only date-edit gate IS applied so changing a task's start date
-- has the same governance as its other dates.
--
-- Purely additive on existing data. Existing tasks get NULL.

ALTER TABLE "Task" ADD COLUMN "startDate" TIMESTAMP(3);
