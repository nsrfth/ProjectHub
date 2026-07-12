-- v2.5.54: PMO (Project Management Office) system role.
--
-- Adds a third per-team system role alongside Manager / Member — a read-only
-- oversight + standards-governance role. DATA-ONLY migration: the Role /
-- RolePermission tables and the `project.read_all` permission string already
-- exist (permissions are code constants in lib/permissions.ts, not an enum),
-- so there is NO schema change and NO `ALTER TYPE`.
--
-- Idempotent — the ON CONFLICT guards let it re-run safely. Mirrors the v1.23
-- `mgr_`/`mem_` id convention with `pmo_<teamId>` so a backfilled PMO role and
-- one freshly created by lib/teamRoles.ts:ensureSystemRoles look identical.

-- 1. One PMO system role per existing team.
INSERT INTO "Role" ("id", "teamId", "name", "description", "isSystem", "createdAt", "updatedAt")
SELECT 'pmo_' || t."id",
       t."id",
       'PMO',
       'Default PMO role. System-managed: editable but undeletable.',
       true,
       NOW(),
       NOW()
FROM "Team" t
ON CONFLICT ("teamId", "name") DO NOTHING;

-- 2. Default PMO permission set — matches DEFAULT_PMO_PERMISSIONS in
--    lib/permissions.ts. Oversight-first: read-all + profile/standards
--    governance + baselines + portfolio view/attach + the two approval gates.
--    No project/task authoring writes.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", p."permission"
FROM "Role" r
CROSS JOIN (VALUES
  ('project.read_all'),
  ('portfolio.view'),
  ('portfolio.attach_project'),
  ('pmo.manage_profiles'),
  ('pmo.assign_profile'),
  ('pmo.override_profile'),
  ('pmo.set_team_defaults'),
  ('pmo.set_group_defaults'),
  ('core.capture_baseline'),
  ('change.approve'),
  ('timesheet.approve')
) AS p("permission")
WHERE r."name" = 'PMO' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- 3. Backfill the new `project.read_all` capability into every existing Manager
--    system role (it joins DEFAULT_MANAGER_PERMISSIONS = the full catalog), so
--    upgraded teams keep Manager ⊇ PMO on read visibility.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'project.read_all'
FROM "Role" r
WHERE r."name" = 'Manager' AND r."isSystem" = true
ON CONFLICT ("roleId", "permission") DO NOTHING;
