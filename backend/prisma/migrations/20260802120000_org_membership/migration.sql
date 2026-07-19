-- v2.9 (Phase 4): the business dimension becomes synced data.
--   D-8: SITE joins the org vocabulary (its own value — PROGRAM-as-site would
--        pollute every by-type roll-up).
--   OrgUnitMembership: SYNC rows are owned by the directory sync; MANUAL rows
--        are admin-placed for local users and never touched by the sync.
--   DirectoryGroupMapping.orgUnitId: the D-3 security-group anchor, same
--        pattern as userGroupId (Phase 1A).
-- Additive + idempotent. Nothing reads OrgUnitMembership until Phase 5, so
-- these rows are inert data until then — which is exactly the Phase 4
-- rollback position.

ALTER TYPE "OrgUnitType" ADD VALUE IF NOT EXISTS 'SITE';

DO $$ BEGIN
  CREATE TYPE "OrgMembershipSource" AS ENUM ('SYNC', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "OrgUnitMembership" (
    "id"        TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "source"    "OrgMembershipSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgUnitMembership_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrgUnitMembership_orgUnitId_fkey" FOREIGN KEY ("orgUnitId")
        REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrgUnitMembership_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrgUnitMembership_orgUnitId_userId_key"
  ON "OrgUnitMembership"("orgUnitId", "userId");
CREATE INDEX IF NOT EXISTS "OrgUnitMembership_userId_idx"
  ON "OrgUnitMembership"("userId");

ALTER TABLE "DirectoryGroupMapping" ADD COLUMN IF NOT EXISTS "orgUnitId" TEXT;
DO $$ BEGIN
  ALTER TABLE "DirectoryGroupMapping"
    ADD CONSTRAINT "DirectoryGroupMapping_orgUnitId_fkey"
    FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "DirectoryGroupMapping_orgUnitId_idx"
  ON "DirectoryGroupMapping"("orgUnitId");
