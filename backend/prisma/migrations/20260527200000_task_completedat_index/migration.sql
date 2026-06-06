-- v1.30.10 (S-18): cover the /reports/done + CompletionTrend
-- "completed in the last N days" shape. Pre-v1.30.10 the planner did a
-- seq scan over the team's partition on every dashboard render.

CREATE INDEX "Task_teamId_completedAt_idx"
  ON "Task"("teamId", "completedAt");
