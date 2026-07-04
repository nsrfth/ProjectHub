-- v2.5.30 (W2.3): full-text search for correspondence.
-- Generated STORED tsvector (config 'simple' — no stemming, safe for the
-- Persian-heavy content; mirrors Task.searchVector). subject + referenceNumber
-- weighted 'A', external ref + body weighted 'B'. GENERATED columns auto-fill
-- existing rows, so no backfill statement is needed.

ALTER TABLE "Correspondence" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("subject", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("referenceNumber", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("externalReferenceNumber", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("body", '')), 'B')
  ) STORED;

CREATE INDEX "Correspondence_searchVector_idx" ON "Correspondence" USING GIN ("searchVector");
