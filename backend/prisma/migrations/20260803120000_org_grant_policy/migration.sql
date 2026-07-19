-- v2.9 (Phase 5): standing org-subtree grant policies, applied once at
-- project creation. sourcePolicyId on ProjectAccessGrant (already present
-- since the Phase 2 migration) is a BARE string, deliberately — it must
-- survive policy deletion so the bulk-revoke script can still enumerate a
-- deleted policy's grants. Additive + idempotent; nothing fires until a
-- policy row exists AND a project is created under its subtree.
CREATE TABLE IF NOT EXISTS "OrgUnitGrantPolicy" (
    "id"              TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "anchorOrgUnitId" TEXT NOT NULL,
    "subjectType"     "ProjectGrantSubject" NOT NULL,
    "subjectId"       TEXT NOT NULL,
    "level"           "ProjectGrantLevel" NOT NULL,
    "enabled"         BOOLEAN NOT NULL DEFAULT true,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgUnitGrantPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrgUnitGrantPolicy_anchorOrgUnitId_fkey" FOREIGN KEY ("anchorOrgUnitId")
        REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "OrgUnitGrantPolicy_anchor_enabled_idx"
  ON "OrgUnitGrantPolicy"("anchorOrgUnitId", "enabled");
