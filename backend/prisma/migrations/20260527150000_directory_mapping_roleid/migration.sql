-- v1.30.6 (S-6 / S-7): DirectoryGroupMapping gains an explicit `roleId`
-- pointer at a Role row. Until now, the LDAP / SCIM provisioning path
-- only set the legacy `role` enum on TeamMembership — so v1.23 custom
-- roles were bypassed for every directory-managed member.
--
-- Additive: nullable column + SetNull FK + index. No backfill needed
-- because:
--   - Existing mappings have `teamRole` (the legacy enum) which is
--     enough for the service to derive the team's system Manager /
--     Member role at provisioning time.
--   - Admins can opt into a custom role per mapping via the new UI
--     once they have v1.30.6 deployed; mappings stay backward
--     compatible until then.

ALTER TABLE "DirectoryGroupMapping" ADD COLUMN "roleId" TEXT;

CREATE INDEX "DirectoryGroupMapping_roleId_idx"
  ON "DirectoryGroupMapping"("roleId");

ALTER TABLE "DirectoryGroupMapping"
  ADD CONSTRAINT "DirectoryGroupMapping_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
