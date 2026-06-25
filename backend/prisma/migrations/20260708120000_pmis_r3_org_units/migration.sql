-- v1.99 (PMIS R3 — portfolio / program): OrgUnit tree above Team.
-- Additive: Project.orgUnitId already exists (plain id from v1.96) — this
-- migration adds the OrgUnit table, the FK, TeamOrgUnit links, and seeds one
-- HOLDING root. Existing projects stay orgUnitId null (invisible to roll-ups).

-- CreateEnum
CREATE TYPE "OrgUnitType" AS ENUM ('HOLDING', 'PORTFOLIO', 'PROGRAM');

-- CreateTable
CREATE TABLE "OrgUnit" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "type" "OrgUnitType" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "managerId" TEXT,
    "currency" "Currency",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgUnit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeamOrgUnit" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamOrgUnit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgUnit_path_idx" ON "OrgUnit"("path");
CREATE INDEX "OrgUnit_parentId_idx" ON "OrgUnit"("parentId");
CREATE INDEX "OrgUnit_type_idx" ON "OrgUnit"("type");
CREATE UNIQUE INDEX "OrgUnit_parentId_code_key" ON "OrgUnit"("parentId", "code");

CREATE UNIQUE INDEX "TeamOrgUnit_teamId_orgUnitId_key" ON "TeamOrgUnit"("teamId", "orgUnitId");
CREATE INDEX "TeamOrgUnit_orgUnitId_idx" ON "TeamOrgUnit"("orgUnitId");

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "OrgUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TeamOrgUnit" ADD CONSTRAINT "TeamOrgUnit_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamOrgUnit" ADD CONSTRAINT "TeamOrgUnit_orgUnitId_fkey" FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed one HOLDING root (stable id for docs / default parent suggestions).
INSERT INTO "OrgUnit" ("id", "parentId", "type", "name", "code", "path", "updatedAt")
VALUES ('orgunit_holding', NULL, 'HOLDING', 'Holding', 'HOLDING', '/orgunit_holding', CURRENT_TIMESTAMP);
