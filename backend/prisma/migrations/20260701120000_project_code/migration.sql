-- v1.92 (PMIS R1 — neutral core): optional human-facing project code, unique
-- within a team when set. Additive and non-breaking: the column is nullable, so
-- existing projects keep code = NULL (Postgres treats NULLs as distinct, so the
-- unique index permits many code-less projects per team).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Project_teamId_code_key" ON "Project"("teamId", "code");
