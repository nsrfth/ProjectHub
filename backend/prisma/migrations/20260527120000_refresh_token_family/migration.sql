-- v1.30.5 (S-4): refresh-token reuse detection requires rotation chains
-- to share a familyId. Additive: add the column nullable, backfill every
-- existing row with familyId = id (each pre-existing token becomes its
-- own family — rotation chains can't be reconstructed retroactively),
-- then promote NOT NULL + index.

ALTER TABLE "RefreshToken" ADD COLUMN "familyId" TEXT;

-- Backfill BEFORE the NOT NULL promotion. Every live token becomes a
-- self-rooted family. The reuse-detection logic in the service only
-- fires when a row is presented that's already revoked, so this
-- backfill never wrongly nukes a session.
UPDATE "RefreshToken" SET "familyId" = "id" WHERE "familyId" IS NULL;

ALTER TABLE "RefreshToken" ALTER COLUMN "familyId" SET NOT NULL;

CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
