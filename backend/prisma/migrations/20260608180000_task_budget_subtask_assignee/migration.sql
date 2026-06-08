-- v1.42: Task budget tracking + Subtask assignee.
--
-- Three additive columns, all nullable. Existing rows get NULL — no
-- backfill, no behaviour change for callers that ignore the new fields.
--
--   Task.plannedBudget / Task.actualSpent
--     Same DECIMAL(18,2) + non-negative CHECK shape as v1.41 Project
--     budgets. Service layer + Zod validation mirror the rules; the
--     CHECK is the defence-in-depth backstop.
--
--   Subtask.assigneeId
--     Mirrors Task.assigneeId. Distinct from the existing
--     Subtask.technicianId (which has manager-gated-change RACI
--     semantics dating to v1.19). The assignee is the "who's working
--     on this right now" — anyone with project access can change it,
--     matching how Task.assigneeId already works. FK SetNull on user
--     delete so deleting a user leaves the subtask intact, just
--     unassigned, mirroring every other person-reference in this
--     schema.

ALTER TABLE "Task"
  ADD COLUMN "plannedBudget" DECIMAL(18, 2),
  ADD COLUMN "actualSpent"   DECIMAL(18, 2);

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_plannedBudget_nonneg_chk"
  CHECK ("plannedBudget" IS NULL OR "plannedBudget" >= 0);

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_actualSpent_nonneg_chk"
  CHECK ("actualSpent" IS NULL OR "actualSpent" >= 0);

ALTER TABLE "Subtask"
  ADD COLUMN "assigneeId" TEXT;

ALTER TABLE "Subtask"
  ADD CONSTRAINT "Subtask_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Subtask_assigneeId_idx" ON "Subtask"("assigneeId");
