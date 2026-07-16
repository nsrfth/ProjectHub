-- v2.5.58: whole-team project sharing. A project stays owned by its home team
-- (Project."teamId" / Task."teamId" denormalization untouched); a row here
-- mounts it into a guest team: the project appears in that team's list and
-- every member gets READONLY=READ / FULL=WRITE (lib/projectAccess.ts).
-- Managed by global ADMINs only. Additive + idempotent.
CREATE TABLE IF NOT EXISTS "ProjectTeamShare" (
    "projectId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "level" "GroupAccessLevel" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectTeamShare_pkey" PRIMARY KEY ("projectId", "teamId"),
    CONSTRAINT "ProjectTeamShare_projectId_fkey" FOREIGN KEY ("projectId")
        REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectTeamShare_teamId_fkey" FOREIGN KEY ("teamId")
        REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ProjectTeamShare_teamId_idx" ON "ProjectTeamShare"("teamId");
