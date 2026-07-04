-- W2.2 (v2.5.26): correspondence Tier-1 — external ref/date, reply-to
-- self-relation, referral due date, and the letter↔task bridge. All additive.

-- Correspondence: counterpart-org reference + date, and reply-to link.
ALTER TABLE "Correspondence" ADD COLUMN "externalReferenceNumber" TEXT;
ALTER TABLE "Correspondence" ADD COLUMN "externalDate" TIMESTAMP(3);
ALTER TABLE "Correspondence" ADD COLUMN "replyToId" TEXT;

-- Referral action-by date.
ALTER TABLE "CorrespondenceReferral" ADD COLUMN "dueAt" TIMESTAMP(3);

-- Indexes.
CREATE INDEX "Correspondence_replyToId_idx" ON "Correspondence"("replyToId");
CREATE INDEX "CorrespondenceReferral_userId_status_dueAt_idx" ON "CorrespondenceReferral"("userId", "status", "dueAt");

-- Reply-to FK (self-relation; SetNull so deleting the parent keeps replies).
ALTER TABLE "Correspondence" ADD CONSTRAINT "Correspondence_replyToId_fkey"
  FOREIGN KEY ("replyToId") REFERENCES "Correspondence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Letter↔task bridge (composite PK = uniqueness; both sides cascade).
CREATE TABLE "CorrespondenceTask" (
    "correspondenceId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CorrespondenceTask_pkey" PRIMARY KEY ("correspondenceId","taskId")
);
CREATE INDEX "CorrespondenceTask_taskId_idx" ON "CorrespondenceTask"("taskId");
ALTER TABLE "CorrespondenceTask" ADD CONSTRAINT "CorrespondenceTask_correspondenceId_fkey"
  FOREIGN KEY ("correspondenceId") REFERENCES "Correspondence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CorrespondenceTask" ADD CONSTRAINT "CorrespondenceTask_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
