-- v1.23: per-team custom roles + per-permission RBAC.
--
-- Strategy: additive only. Existing TeamMembership.role enum stays as a
-- fallback while we backfill TeamMembership.roleId; the service layer reads
-- roleId first and falls back to the enum if null. v1.24 will drop the enum.

-- 1. Tables.
CREATE TABLE "Role" (
  "id"          TEXT PRIMARY KEY,
  "teamId"      TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "isSystem"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Role_teamId_fkey" FOREIGN KEY ("teamId")
    REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Role_teamId_name_key" ON "Role"("teamId", "name");
CREATE INDEX "Role_teamId_idx" ON "Role"("teamId");

CREATE TABLE "RolePermission" (
  "roleId"     TEXT NOT NULL,
  "permission" TEXT NOT NULL,
  PRIMARY KEY ("roleId", "permission"),
  CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId")
    REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 2. Extend TeamMembership with the new FK column.
ALTER TABLE "TeamMembership" ADD COLUMN "roleId" TEXT;
CREATE INDEX "TeamMembership_roleId_idx" ON "TeamMembership"("roleId");
ALTER TABLE "TeamMembership"
  ADD CONSTRAINT "TeamMembership_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Backfill: for every existing team, create Manager + Member system roles
--    and populate their default permission sets.
--
-- Generate stable ids by prefixing the teamId so retries are idempotent in
-- principle (the unique (teamId, name) constraint also prevents dupes).

INSERT INTO "Role" ("id", "teamId", "name", "description", "isSystem", "updatedAt")
SELECT
  'mgr_' || "id",
  "id",
  'Manager',
  'Default Manager role. System-managed: editable but undeletable.',
  true,
  CURRENT_TIMESTAMP
FROM "Team";

INSERT INTO "Role" ("id", "teamId", "name", "description", "isSystem", "updatedAt")
SELECT
  'mem_' || "id",
  "id",
  'Member',
  'Default Member role. System-managed: editable but undeletable.',
  true,
  CURRENT_TIMESTAMP
FROM "Team";

-- Manager gets all 15 permissions per team.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT 'mgr_' || t."id", p.perm
FROM "Team" t
CROSS JOIN (VALUES
  ('task.delete'),
  ('task.modify_dates'),
  ('task.change_technician'),
  ('task.change_assignee'),
  ('comment.delete_others'),
  ('project.edit'),
  ('project.delete'),
  ('project.set_accountable'),
  ('team.invite_member'),
  ('team.remove_member'),
  ('team.change_role'),
  ('team.manage_roles'),
  ('labels.manage'),
  ('webhooks.manage'),
  ('trash.purge')
) AS p(perm);

-- Member gets only the two permissions that today's MEMBER role implicitly
-- has (any team member can delete tasks + modify their dates, subject to
-- the v1.18 dateEditRestriction InstanceSetting on top).
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT 'mem_' || t."id", p.perm
FROM "Team" t
CROSS JOIN (VALUES
  ('task.delete'),
  ('task.modify_dates')
) AS p(perm);

-- 4. Backfill TeamMembership.roleId: point each existing membership at the
--    matching system role for its team. Untouched if the legacy role enum
--    is somehow NULL (defensive).
UPDATE "TeamMembership" tm
SET "roleId" = CASE tm."role"
  WHEN 'MANAGER' THEN 'mgr_' || tm."teamId"
  WHEN 'MEMBER'  THEN 'mem_' || tm."teamId"
END
WHERE tm."role" IS NOT NULL;
