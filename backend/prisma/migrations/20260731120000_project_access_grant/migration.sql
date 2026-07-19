-- v2.6 (Phase 2): the unified project-access grant table.
--
-- Additive ONLY. ProjectGroupGrant and ProjectTeamShare are untouched and stay
-- authoritative for the whole dual-read period — that is precisely what makes
-- the `access.unifiedGrants` flag reversible: switching it back to `off`
-- restores legacy resolution instantly because the legacy tables were never
-- stopped being written. They are dropped in Phase 6, not here.

DO $$ BEGIN
  CREATE TYPE "ProjectGrantSubject" AS ENUM ('USER', 'GROUP', 'TEAM', 'ORG_UNIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ProjectGrantLevel" AS ENUM ('READ', 'WRITE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ProjectGrantStatus" AS ENUM ('PENDING', 'ACTIVE', 'DECLINED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ProjectAccessGrant" (
    "id"             TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "subjectType"    "ProjectGrantSubject" NOT NULL,
    -- Polymorphic subject id. No FK by design: it points at User, UserGroup,
    -- Team, or OrgUnit depending on subjectType. The resolver treats an
    -- unresolvable subject as no-access, and the access report surfaces it.
    "subjectId"      TEXT NOT NULL,
    "level"          "ProjectGrantLevel" NOT NULL,
    "status"         "ProjectGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedById"    TEXT,
    "grantedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- 'backfill:group' | 'backfill:team' | 'backfill:delegate' | 'policy' | NULL
    "source"         TEXT,
    "sourcePolicyId" TEXT,
    "expiresAt"      TIMESTAMP(3),

    CONSTRAINT "ProjectAccessGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectAccessGrant_projectId_fkey" FOREIGN KEY ("projectId")
        REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectAccessGrant_grantedById_fkey" FOREIGN KEY ("grantedById")
        REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- One grant per (project, subject, level). Holding both READ and WRITE for the
-- same subject is legal and resolves to the higher — which makes "upgrade READ
-- to WRITE" an idempotent insert rather than an update race, and makes the
-- backfill safely re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectAccessGrant_project_subject_level_key"
  ON "ProjectAccessGrant"("projectId", "subjectType", "subjectId", "level");

CREATE INDEX IF NOT EXISTS "ProjectAccessGrant_projectId_status_idx"
  ON "ProjectAccessGrant"("projectId", "status");

-- The reverse lookup the list-filter helpers need: "which projects does this
-- subject reach?" Without it, every project list does a sequential scan.
CREATE INDEX IF NOT EXISTS "ProjectAccessGrant_subject_status_idx"
  ON "ProjectAccessGrant"("subjectType", "subjectId", "status");

-- Phase 5 bulk-revoke path.
CREATE INDEX IF NOT EXISTS "ProjectAccessGrant_sourcePolicyId_idx"
  ON "ProjectAccessGrant"("sourcePolicyId");
