-- v2.5.58: Hold column for the kanban board.
-- New TaskStatus value for parked/blocked tasks. Entering ON_HOLD requires a
-- mandatory explanatory comment — enforced in tasksService (statusComment),
-- not at the DB layer. Idempotent: IF NOT EXISTS guards re-runs.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD' AFTER 'IN_PROGRESS';
