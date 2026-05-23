-- Phase 2B: SCIM bearer credentials + soft-disable on User.

CREATE TABLE "ScimCredential" (
    "id" TEXT NOT NULL,
    "directoryId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ScimCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScimCredential_directoryId_key" ON "ScimCredential"("directoryId");
CREATE UNIQUE INDEX "ScimCredential_tokenHash_key" ON "ScimCredential"("tokenHash");
CREATE INDEX "ScimCredential_directoryId_idx" ON "ScimCredential"("directoryId");

ALTER TABLE "ScimCredential"
    ADD CONSTRAINT "ScimCredential_directoryId_fkey"
    FOREIGN KEY ("directoryId") REFERENCES "Directory"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Soft-disable column. Login + refresh reject when non-null.
ALTER TABLE "User" ADD COLUMN "disabledAt" TIMESTAMP(3);
