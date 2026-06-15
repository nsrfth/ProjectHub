-- v1.72: optional project start/end calendar dates (UTC midnight).
ALTER TABLE "Project" ADD COLUMN "startDate" TIMESTAMP(3),
ADD COLUMN "endDate" TIMESTAMP(3);

CREATE INDEX "Project_teamId_startDate_idx" ON "Project"("teamId", "startDate");
