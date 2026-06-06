-- v1.30.8 (S-22): grant the new `team.edit_details` permission to every
-- existing system Manager role so default behaviour doesn't change.
-- The v1.23 + v1.29 convention: a new permission constant needs both
-- the lib/permissions.ts entry AND this backfill — otherwise existing
-- teams' Manager role would suddenly LOSE a capability they had under
-- the legacy requireTeamRole('MANAGER') gate.

INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'team.edit_details'
FROM "Role" r
WHERE r."name" = 'Manager' AND r."isSystem" = true
ON CONFLICT DO NOTHING;
