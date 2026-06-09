-- Remove per-project bucket grouping feature.

DROP INDEX IF EXISTS "Task_projectId_bucketId_position_idx";

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_bucketId_fkey";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "bucketId";

DROP TABLE IF EXISTS "Bucket";

DELETE FROM "RolePermission" WHERE "permission" = 'buckets.manage';
