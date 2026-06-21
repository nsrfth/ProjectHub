-- v1.88: granular per-project delegate capabilities.
-- Replaces the all-or-nothing full-edit delegate with a per-delegate capability
-- list. Every pre-existing delegate was full-edit, so migrate them to ['FULL']
-- (FULL implies every other capability) — no behavior change for current rows.
ALTER TABLE "ProjectEditDelegate" ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "ProjectEditDelegate" SET "capabilities" = ARRAY['FULL']::TEXT[] WHERE cardinality("capabilities") = 0;
