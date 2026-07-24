-- v-next (cross-unit task assignment workflow), Slice 1.
-- Curated to the additive changes only (the raw `prisma migrate diff` also
-- surfaced pre-existing schema drift — searchVector index drops, updatedAt
-- DROP DEFAULTs, index renames — which is NOT part of this feature and is left
-- out on purpose). Validated against the LAN test DB (taskhub_test) 2026-07-24.

-- CreateEnum
CREATE TYPE "AssignmentTargetType" AS ENUM ('GROUP', 'TEAM');

-- CreateEnum
CREATE TYPE "AssignmentRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'FORWARDED', 'ASSIGNED', 'DECLINED', 'EXPIRED');

-- AlterEnum
-- Two standalone ADD VALUEs. Nothing in this migration USES them, so the
-- Postgres "new enum value can't be used in the same transaction" rule does not
-- apply (they are consumed only at runtime, from Slice 5 onward).
ALTER TYPE "NotifyType" ADD VALUE 'ASSIGNMENT_REQUESTED';
ALTER TYPE "NotifyType" ADD VALUE 'ASSIGNMENT_DECIDED';

-- CreateTable
CREATE TABLE "TaskAssignmentRequest" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "targetType" "AssignmentTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "proposedId" TEXT,
    "status" "AssignmentRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "approverId" TEXT,
    "forwardedToId" TEXT,
    "assigneeId" TEXT,
    "declineReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "TaskAssignmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskAssignmentRequest_teamId_status_idx" ON "TaskAssignmentRequest"("teamId", "status");

-- CreateIndex
CREATE INDEX "TaskAssignmentRequest_taskId_idx" ON "TaskAssignmentRequest"("taskId");

-- CreateIndex
CREATE INDEX "TaskAssignmentRequest_targetType_targetId_status_idx" ON "TaskAssignmentRequest"("targetType", "targetId", "status");

-- CreateIndex
CREATE INDEX "TaskAssignmentRequest_requesterId_status_idx" ON "TaskAssignmentRequest"("requesterId", "status");

-- AddForeignKey
ALTER TABLE "TaskAssignmentRequest" ADD CONSTRAINT "TaskAssignmentRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignmentRequest" ADD CONSTRAINT "TaskAssignmentRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignmentRequest" ADD CONSTRAINT "TaskAssignmentRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
