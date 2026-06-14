-- v1.65: per-user TASK_DUE reminder lead time.
ALTER TABLE "User" ADD COLUMN "reminderLeadHours" INTEGER DEFAULT 24;
