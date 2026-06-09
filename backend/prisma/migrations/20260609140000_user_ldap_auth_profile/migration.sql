-- CreateEnum
CREATE TYPE "AuthSource" AS ENUM ('LOCAL', 'LDAP', 'SCIM');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "authSource" "AuthSource" NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "User" ADD COLUMN "ldapUsername" TEXT;
ALTER TABLE "User" ADD COLUMN "userPrincipalName" TEXT;
ALTER TABLE "User" ADD COLUMN "department" TEXT;
ALTER TABLE "User" ADD COLUMN "jobTitle" TEXT;
ALTER TABLE "User" ADD COLUMN "managerName" TEXT;
ALTER TABLE "User" ADD COLUMN "ldapSyncedAt" TIMESTAMP(3);

-- Backfill authSource from existing directory links.
UPDATE "User" u
SET "authSource" = 'LDAP'
FROM "Directory" d
WHERE u."directoryId" = d.id AND d.kind = 'LDAP';

UPDATE "User" u
SET "authSource" = 'SCIM'
FROM "Directory" d
WHERE u."directoryId" = d.id AND d.kind = 'SCIM';
