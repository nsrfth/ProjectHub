-- v2.16: optional sub-units (اداره) inside departments. Additive + idempotent.
-- Membership stays on the DEPARTMENT: the one-unit partial index, assignment
-- scoping and the directory sync are all untouched. A sub-unit is a tag.
ALTER TYPE "UserGroupKind" ADD VALUE IF NOT EXISTS 'SUBUNIT';

ALTER TABLE "UserGroup" ADD COLUMN IF NOT EXISTS "parentId" TEXT;
DO $$ BEGIN
  ALTER TABLE "UserGroup"
    ADD CONSTRAINT "UserGroup_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "UserGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "UserGroup_parentId_idx" ON "UserGroup"("parentId");

ALTER TABLE "UserGroupMember" ADD COLUMN IF NOT EXISTS "subUnitId" TEXT;
DO $$ BEGIN
  ALTER TABLE "UserGroupMember"
    ADD CONSTRAINT "UserGroupMember_subUnitId_fkey"
    FOREIGN KEY ("subUnitId") REFERENCES "UserGroup"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "UserGroupMember_subUnitId_idx" ON "UserGroupMember"("subUnitId");
