-- Phase 4.1: add QUARTERLY to the RecurrenceFrequency enum.
-- Postgres 12+ allows ADD VALUE inside a transaction, so no special
-- non-transactional handling is needed. Placed BEFORE 'YEARLY' so the
-- enum order matches the chronological cadence.
ALTER TYPE "RecurrenceFrequency" ADD VALUE 'QUARTERLY' BEFORE 'YEARLY';
