-- v1.48: grant `team.delete` to every existing system Manager role (same
-- backfill convention as team.edit_details).
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'team.delete'
FROM "Role" r
WHERE r."isSystem" = true AND r."name" = 'Manager'
ON CONFLICT DO NOTHING;
