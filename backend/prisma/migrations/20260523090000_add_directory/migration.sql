-- Phase 2A: multi-directory identity. All changes are additive/nullable so the
-- migration is non-destructive on existing data.

-- DirectoryKind enum (LDAP today, SCIM reserved for Phase 2B).
CREATE TYPE "DirectoryKind" AS ENUM ('LDAP', 'SCIM');

-- Directory: external identity provider config.
CREATE TABLE "Directory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "DirectoryKind" NOT NULL DEFAULT 'LDAP',
    "host" TEXT,
    "port" INTEGER,
    "useTLS" BOOLEAN NOT NULL DEFAULT true,
    "bindDN" TEXT,
    "bindPasswordEnc" TEXT,
    "baseDN" TEXT,
    "userFilter" TEXT,
    "groupFilter" TEXT,
    "userIdAttr" TEXT NOT NULL DEFAULT 'uid',
    "emailAttr" TEXT NOT NULL DEFAULT 'mail',
    "nameAttr" TEXT NOT NULL DEFAULT 'cn',
    "groupMemberAttr" TEXT NOT NULL DEFAULT 'member',
    "allowJIT" BOOLEAN NOT NULL DEFAULT true,
    "syncRolesFromGroups" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Directory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Directory_slug_key" ON "Directory"("slug");

-- DirectoryGroupMapping: external group DN → TaskHub role assignment.
CREATE TABLE "DirectoryGroupMapping" (
    "id" TEXT NOT NULL,
    "directoryId" TEXT NOT NULL,
    "externalGroupDn" TEXT NOT NULL,
    "globalRole" "GlobalRole",
    "teamId" TEXT,
    "teamRole" "TeamRole",

    CONSTRAINT "DirectoryGroupMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DirectoryGroupMapping_directoryId_externalGroupDn_key"
    ON "DirectoryGroupMapping"("directoryId", "externalGroupDn");
CREATE INDEX "DirectoryGroupMapping_directoryId_idx"
    ON "DirectoryGroupMapping"("directoryId");

ALTER TABLE "DirectoryGroupMapping"
    ADD CONSTRAINT "DirectoryGroupMapping_directoryId_fkey"
    FOREIGN KEY ("directoryId") REFERENCES "Directory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- User additions: directoryId + externalId. passwordHash drops NOT NULL —
-- LDAP-managed users have no local password.
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "directoryId" TEXT;
ALTER TABLE "User" ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "User_directoryId_externalId_key"
    ON "User"("directoryId", "externalId");
CREATE INDEX "User_directoryId_idx" ON "User"("directoryId");
ALTER TABLE "User"
    ADD CONSTRAINT "User_directoryId_fkey"
    FOREIGN KEY ("directoryId") REFERENCES "Directory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Team addition: directoryId — teams that are wholly managed by a directory.
ALTER TABLE "Team" ADD COLUMN "directoryId" TEXT;
CREATE INDEX "Team_directoryId_idx" ON "Team"("directoryId");
ALTER TABLE "Team"
    ADD CONSTRAINT "Team_directoryId_fkey"
    FOREIGN KEY ("directoryId") REFERENCES "Directory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
