-- v2.1.1 (PMIS R1 supplement): materialize WBS columns (wbsPath, wbsDepth,
-- isSummary) and add PercentCompleteMode enum to Task. Previously all three
-- were derived at read time in projectWbs(); storing them enables SQL subtree
-- queries (wbsPath LIKE prefix) and EVM leaf detection (isSummary = false).

-- CreateEnum
CREATE TYPE "PercentCompleteMode" AS ENUM ('MANUAL', 'FROM_CHILDREN', 'FROM_STATUS');

-- AddColumns
ALTER TABLE "Task"
  ADD COLUMN "percentCompleteMode" "PercentCompleteMode" NOT NULL DEFAULT 'FROM_CHILDREN',
  ADD COLUMN "wbsPath"  TEXT,
  ADD COLUMN "wbsDepth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "isSummary" BOOLEAN NOT NULL DEFAULT false;

-- Backfill wbsPath + wbsDepth via recursive CTE.
-- Safe as long as no cycles exist; move() has prevented new cycles since v1.97.
WITH RECURSIVE wbs AS (
  SELECT id, CAST(('/' || id) AS TEXT) AS path, 0 AS depth
  FROM   "Task"
  WHERE  "parentId" IS NULL
  UNION ALL
  SELECT t.id, (wbs.path || '/' || t.id)::TEXT, wbs.depth + 1
  FROM   "Task" t
  INNER JOIN wbs ON t."parentId" = wbs.id
  WHERE  wbs.depth < 21
)
UPDATE "Task" SET "wbsPath" = wbs.path, "wbsDepth" = wbs.depth
FROM wbs WHERE "Task".id = wbs.id;

-- Any task whose parentId pointed to a non-existent task → treat as root
UPDATE "Task" SET "wbsPath" = '/' || id, "wbsDepth" = 0 WHERE "wbsPath" IS NULL;

-- Backfill isSummary: tasks that are the parent of at least one live task
UPDATE "Task" SET "isSummary" = true
WHERE id IN (
  SELECT DISTINCT "parentId" FROM "Task"
  WHERE  "parentId" IS NOT NULL AND "deletedAt" IS NULL
);

-- CreateIndex
CREATE INDEX "Task_projectId_wbsPath_idx" ON "Task"("projectId", "wbsPath");
