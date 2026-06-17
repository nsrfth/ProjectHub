-- v1.80: global "predefined" labels. A Label row with teamId = NULL is a
-- global, admin-managed predefined label — visible and usable in every team,
-- read-only to members. Existing labels are all team-scoped and untouched.

-- 1. Allow NULL teamId (global labels carry no team).
ALTER TABLE "Label" ALTER COLUMN "teamId" DROP NOT NULL;

-- 2. Replace the single unique(teamId,name) index with two PARTIAL unique
--    indexes: team labels stay unique per (teamId,name); globals are unique by
--    name on their own. (Postgres treats NULLs as distinct, so the old combined
--    index would have allowed duplicate-named globals.)
DROP INDEX IF EXISTS "Label_teamId_name_key";
CREATE UNIQUE INDEX "Label_team_name_key" ON "Label" ("teamId", "name") WHERE "teamId" IS NOT NULL;
CREATE UNIQUE INDEX "Label_global_name_key" ON "Label" ("name") WHERE "teamId" IS NULL;

-- 3. Keep a plain index for team-scoped list queries (the old unique covered
--    this; its partial replacement does too, but be explicit for null lookups).
CREATE INDEX IF NOT EXISTS "Label_teamId_idx" ON "Label" ("teamId");
