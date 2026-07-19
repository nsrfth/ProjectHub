-- v2.8 (Phase 3): notification types for the grant-consent flow.
-- NotifyType is a native Postgres enum (same lesson as the themes enum:
-- TS/zod alone is not enough). Additive + idempotent.
ALTER TYPE "NotifyType" ADD VALUE IF NOT EXISTS 'GRANT_PENDING';
ALTER TYPE "NotifyType" ADD VALUE IF NOT EXISTS 'GRANT_DECIDED';
