-- v1.34: Buckets — per-project ordered task grouping.
--
-- Purely additive. Existing Task rows get bucketId = NULL (= unbucketed)
-- without a backfill. Deleting a bucket nulls Task.bucketId at the DB level
-- (ON DELETE SET NULL); the service contract also enforces this, but the
-- FK rule is defense in depth.
--
-- `order` is intentionally NOT unique — sort key, not identity. Reorder
-- uses a two-phase write in the service layer (bump to a collision-free
-- range, then settle to 0..n-1) so no intermediate state has duplicate
-- values within a project. Matches the Task.position precedent.

CREATE TABLE "Bucket" (
  "id"        TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "teamId"    TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "order"     INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Bucket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Bucket_projectId_order_idx" ON "Bucket" ("projectId", "order");
CREATE INDEX "Bucket_teamId_idx"          ON "Bucket" ("teamId");

ALTER TABLE "Bucket"
  ADD CONSTRAINT "Bucket_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable bucket reference on Task. No default; existing rows get NULL.
ALTER TABLE "Task" ADD COLUMN "bucketId" TEXT;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_bucketId_fkey"
  FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Composite index for bucket-grouped board reads. Mirrors the existing
-- (projectId, status, position) kanban index.
CREATE INDEX "Task_projectId_bucketId_position_idx"
  ON "Task" ("projectId", "bucketId", "position");

-- v1.34: grant the new `buckets.manage` permission to existing system
-- Manager AND Member roles so default behaviour matches a fresh-install
-- seed. Same backfill convention as the v1.30.8 team.edit_details
-- migration.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'buckets.manage'
FROM "Role" r
WHERE r."name" IN ('Manager', 'Member') AND r."isSystem" = true
ON CONFLICT DO NOTHING;
