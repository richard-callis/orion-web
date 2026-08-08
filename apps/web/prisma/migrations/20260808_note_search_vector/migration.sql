-- Hybrid search (dense vector + keyword) for the Note knowledge base.
--
-- Mirrors the InvestigationNote full-text search pattern (migration
-- 10_soc_case_management: "searchVector" tsvector + GIN index, queried via
-- to_tsquery in apps/web/src/app/api/monitoring/security/investigations/_utils.ts)
-- with one difference: InvestigationNote's searchVector is populated
-- application-side on every write (updateSearchVector()), which requires
-- every write path to remember to call it. Note has several independent
-- write paths (notes API, worker task-outcome writes, Dream's
-- extraction/synthesis pipeline) so instead this uses a native Postgres
-- GENERATED ALWAYS ... STORED column — it can never drift out of sync with
-- title/content because Postgres recomputes it transactionally on every
-- INSERT/UPDATE, with no application code required.
--
-- Title is weighted 'A' (highest), content 'B', matching the setweight()
-- convention Postgres full-text search uses for ts_rank_cd relevance.
--
-- Idempotent: IF NOT EXISTS guards on both the column add and the index.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Note' AND column_name = 'searchVector'
  ) THEN
    ALTER TABLE "Note"
      ADD COLUMN "searchVector" tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("content", '')), 'B')
      ) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Note_searchVector_idx" ON "Note" USING gin("searchVector");
