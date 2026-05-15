-- Migration: convert note_embeddings.embedding from text to native vector(768) type
-- and add HNSW index for sub-millisecond cosine similarity search.
--
-- The text column stores JSON arrays like [0.1, -0.3, ...] which pgvector
-- accepts directly via the USING cast. Existing rows are preserved.
--
-- Idempotent: skips ALTER if column is already vector type; uses IF NOT EXISTS for index.
-- If switching to OpenAI text-embedding-3-small (1536-dim), re-run embedAllNotes() and
-- alter to vector(1536) before creating the index.

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'note_embeddings' AND column_name = 'embedding') = 'text' THEN
    ALTER TABLE note_embeddings
      ALTER COLUMN embedding TYPE vector(768)
      USING embedding::vector(768);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS note_embeddings_embedding_hnsw_idx
  ON note_embeddings
  USING hnsw (embedding vector_cosine_ops);
