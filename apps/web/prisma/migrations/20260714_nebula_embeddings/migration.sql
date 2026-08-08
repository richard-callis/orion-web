-- Vector embeddings for skills (NebulaInstance category:'skill'), for semantic
-- trigger matching alongside the existing exact substring match.
--
-- New table, so unlike note_embeddings this can be created directly as native
-- vector(768) — no text->vector ALTER migration needed. 768 dims matches the
-- existing embedding pipeline's default (Ollama nomic-embed-text); if the
-- deployment uses OpenAI text-embedding-3-small (1536 dims) instead, re-embed
-- all skills and ALTER COLUMN embedding TYPE vector(1536) same as
-- 7_note_embeddings_hnsw_index did for notes.

CREATE TABLE IF NOT EXISTS "nebula_embeddings" (
    "nebulaId"  TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "dimension" INTEGER NOT NULL,
    "modelRef"  TEXT,
    "version"   INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nebula_embeddings_pkey" PRIMARY KEY ("nebulaId")
);

ALTER TABLE "nebula_embeddings"
  ADD CONSTRAINT "nebula_embeddings_nebulaId_fkey"
  FOREIGN KEY ("nebulaId") REFERENCES "NebulaInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS nebula_embeddings_embedding_hnsw_idx
  ON nebula_embeddings
  USING hnsw (embedding vector_cosine_ops);
