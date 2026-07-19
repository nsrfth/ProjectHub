-- v2.6 (Phase 0a): scheduled directory sync state on Directory.
--
-- "syncEnabled" is deliberately NOT the existing "syncRolesFromGroups": that
-- flag gates login-time group mapping. Reusing it would silently start a
-- nightly directory walk on every installation that had enabled login-time
-- mapping, which is a behaviour change on upgrade. Both default false, so this
-- migration is inert until an admin opts in per directory AND the process is
-- started with DIRECTORY_SYNC_ENABLED=true.
--
-- "syncTrustMemberOf" false = run pass 2 (expand each mapped group's members)
-- in addition to reading memberOf. Correct default: memberOf is an AD back-link
-- that OpenLDAP does not populate without the memberof overlay, so trusting it
-- blindly under-grants.
--
-- Additive + idempotent. See docs/DIRECTORY_SYNC.md §9.
ALTER TABLE "Directory" ADD COLUMN IF NOT EXISTS "syncEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Directory" ADD COLUMN IF NOT EXISTS "syncTrustMemberOf" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Directory" ADD COLUMN IF NOT EXISTS "lastSyncAt" TIMESTAMP(3);
ALTER TABLE "Directory" ADD COLUMN IF NOT EXISTS "lastSyncStatus" TEXT;
ALTER TABLE "Directory" ADD COLUMN IF NOT EXISTS "lastSyncSummary" JSONB;
