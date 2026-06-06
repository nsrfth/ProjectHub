-- v1.30: full-text search via Postgres tsvector.
--
-- One generated `searchVector` column per searchable entity (Task / Comment
-- / Project), each backed by its own GIN index. Configuration is `simple`
-- (no stemming) because TaskHub content is heavily Persian — the english
-- stemmer would mangle Persian tokens. simple just lowercases + splits on
-- whitespace/punctuation, which works well across both languages.
--
-- title fields get `setweight('A')` and description-style fields get
-- `setweight('B')`, so ts_rank biases title hits over description hits.
-- The Comment vector is unweighted (only one field — body).
--
-- The columns + indexes are managed entirely by raw SQL; schema.prisma
-- declares them as Unsupported("tsvector")? @ignore so prisma migrate
-- doesn't treat them as drift but the generated client never reads them.

-- ── Task ────────────────────────────────────────────────────────────────
ALTER TABLE "Task" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'B')
  ) STORED;

CREATE INDEX "Task_searchVector_idx" ON "Task" USING GIN ("searchVector");

-- ── Comment ─────────────────────────────────────────────────────────────
ALTER TABLE "Comment" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce("body", ''))
  ) STORED;

CREATE INDEX "Comment_searchVector_idx" ON "Comment" USING GIN ("searchVector");

-- ── Project ─────────────────────────────────────────────────────────────
ALTER TABLE "Project" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'B')
  ) STORED;

CREATE INDEX "Project_searchVector_idx" ON "Project" USING GIN ("searchVector");
