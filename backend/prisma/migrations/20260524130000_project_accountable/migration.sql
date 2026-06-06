-- v1.17: Project."accountableId" — RACI "Accountable" person for a project.
-- Nullable so existing rows stay valid; SET NULL on user delete so deleting
-- a user doesn't cascade-nuke their projects.
ALTER TABLE "Project" ADD COLUMN "accountableId" TEXT;

CREATE INDEX "Project_accountableId_idx" ON "Project"("accountableId");

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_accountableId_fkey"
  FOREIGN KEY ("accountableId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
