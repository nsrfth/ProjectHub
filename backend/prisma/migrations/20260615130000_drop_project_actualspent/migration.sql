-- v1.73: drop manual project actualSpent (destructive — existing values discarded).
-- Task.actualSpent is unchanged; budget report uses plannedBudget only at project level.
ALTER TABLE "Project" DROP COLUMN "actualSpent";
