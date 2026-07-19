-- v2.6 (Phase 1A): units, group roles, and the single-unit constraint.
--
-- Additive and idempotent. Every existing group becomes COLLAB (its current
-- semantics, unchanged) and every existing member becomes MEMBER, so there is
-- no behavioural change until an admin creates a UNIT.

-- ---------------------------------------------------------------- enums
DO $$ BEGIN
  CREATE TYPE "UserGroupKind" AS ENUM ('UNIT', 'COLLAB');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "GroupRole" AS ENUM ('MANAGER', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- columns
ALTER TABLE "UserGroup"
  ADD COLUMN IF NOT EXISTS "kind" "UserGroupKind" NOT NULL DEFAULT 'COLLAB';

ALTER TABLE "UserGroupMember"
  ADD COLUMN IF NOT EXISTS "role" "GroupRole" NOT NULL DEFAULT 'MEMBER';

-- Denormalized from the parent UserGroup. See the schema comment on
-- UserGroupMember for why this cannot be avoided: the single-unit rule needs a
-- partial unique index on (userId, teamId), teamId lives on UserGroup, and a
-- partial index cannot reference another table.
ALTER TABLE "UserGroupMember"
  ADD COLUMN IF NOT EXISTS "teamId" TEXT;
ALTER TABLE "UserGroupMember"
  ADD COLUMN IF NOT EXISTS "isUnit" BOOLEAN NOT NULL DEFAULT false;

-- v2.6 (Phase 1A, D-3 = security groups): unit anchor on the existing DN-keyed
-- mapping table. SetNull so removing a unit degrades the mapping to "team
-- membership only" rather than cascading away the team grant with it.
ALTER TABLE "DirectoryGroupMapping"
  ADD COLUMN IF NOT EXISTS "userGroupId" TEXT;

DO $$ BEGIN
  ALTER TABLE "DirectoryGroupMapping"
    ADD CONSTRAINT "DirectoryGroupMapping_userGroupId_fkey"
    FOREIGN KEY ("userGroupId") REFERENCES "UserGroup"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "DirectoryGroupMapping_userGroupId_idx"
  ON "DirectoryGroupMapping"("userGroupId");

-- ---------------------------------------------------------------- backfill
-- Populate the denormalized columns for rows that already exist. Every group is
-- COLLAB at this point, so isUnit is false everywhere and the partial index
-- below starts out covering zero rows.
UPDATE "UserGroupMember" m
   SET "teamId" = g."teamId",
       "isUnit" = (g."kind" = 'UNIT')
  FROM "UserGroup" g
 WHERE m."groupId" = g."id"
   AND (m."teamId" IS DISTINCT FROM g."teamId" OR m."isUnit" IS DISTINCT FROM (g."kind" = 'UNIT'));

-- ---------------------------------------------------------------- trigger
-- The denormalized columns are maintained by the database, not by the service
-- layer.
--
-- This is deliberate. A denormalized column kept correct "by convention" is one
-- forgotten code path away from letting a person hold two units — which is the
-- exact invariant the partial index exists to enforce. Assignment scoping in
-- Phase 1C reads unit membership on every assignment check, so a stale row is
-- an authorization bug, not a reporting glitch.
--
-- Two triggers are needed:
--   1. on UserGroupMember insert/update — stamp from the parent group
--   2. on UserGroup update of kind/teamId — restamp all its members
CREATE OR REPLACE FUNCTION "userGroupMember_denorm"() RETURNS TRIGGER AS $$
BEGIN
  SELECT g."teamId", (g."kind" = 'UNIT')
    INTO NEW."teamId", NEW."isUnit"
    FROM "UserGroup" g
   WHERE g."id" = NEW."groupId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "userGroupMember_denorm_trg" ON "UserGroupMember";
CREATE TRIGGER "userGroupMember_denorm_trg"
  BEFORE INSERT OR UPDATE OF "groupId" ON "UserGroupMember"
  FOR EACH ROW EXECUTE FUNCTION "userGroupMember_denorm"();

CREATE OR REPLACE FUNCTION "userGroup_restamp_members"() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW."kind" IS DISTINCT FROM OLD."kind")
     OR (NEW."teamId" IS DISTINCT FROM OLD."teamId") THEN
    UPDATE "UserGroupMember"
       SET "teamId" = NEW."teamId",
           "isUnit" = (NEW."kind" = 'UNIT')
     WHERE "groupId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "userGroup_restamp_members_trg" ON "UserGroup";
CREATE TRIGGER "userGroup_restamp_members_trg"
  AFTER UPDATE ON "UserGroup"
  FOR EACH ROW EXECUTE FUNCTION "userGroup_restamp_members"();

-- ---------------------------------------------------------------- constraint
-- At most ONE unit membership per person per team.
--
-- Partial, so COLLAB memberships are entirely unaffected — a person may belong
-- to any number of collaboration groups in the same team, which is the whole
-- point of them.
--
-- UNIQUE INDEX (not a CHECK) because this must hold under concurrent inserts:
-- two simultaneous requests each adding the same person to a different unit
-- must have exactly one fail, and only the index gives that.
CREATE UNIQUE INDEX IF NOT EXISTS "UserGroupMember_one_unit_per_team"
  ON "UserGroupMember"("userId", "teamId")
  WHERE "isUnit" = true;

CREATE INDEX IF NOT EXISTS "UserGroupMember_userId_teamId_isUnit_idx"
  ON "UserGroupMember"("userId", "teamId", "isUnit");
