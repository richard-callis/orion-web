/**
 * Knowledge graph embedding utilities.
 *
 * Generates vector embeddings for notes using ORION's configured embedding
 * providers (OpenAI text-embedding-3-small or Ollama nomic-embed-text).
 * Stores embeddings in PostgreSQL via pgvector for semantic search.
 *
 * Requires the pgvector PostgreSQL extension:
 *   CREATE EXTENSION IF NOT EXISTS vector;
 */

import { prisma } from './db'

// ── Providers ────────────────────────────────────────────────────────────────

interface EmbeddingResult {
  vector: number[]
  modelRef: string
}

async function getEmbeddingProvider(): Promise<{
  baseUrl: string
  apiKey?: string
  modelId: string
  provider: 'openai' | 'ollama'
} | null> {
  const models = await prisma.externalModel.findMany({ where: { enabled: true } })

  // OpenAI text-embedding models first
  const openai = models.find(
    m => m.provider === 'openai' && m.modelId.includes('text-embedding'),
  )
  if (openai) {
    return {
      baseUrl: openai.baseUrl,
      apiKey: openai.apiKey ?? '',
      modelId: openai.modelId,
      provider: 'openai',
    }
  }

  // Fallback: Ollama (typically nomic-embed-text or bge-m3)
  const ollama = models.find(m => m.provider === 'ollama')
  if (ollama && ollama.baseUrl) {
    return {
      baseUrl: ollama.baseUrl,
      modelId: ollama.modelId,
      provider: 'ollama',
    }
  }

  return null
}

// ── Embedding Generation ─────────────────────────────────────────────────────

/**
 * Generate a text embedding using the configured provider.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult | null> {
  const provider = await getEmbeddingProvider()
  if (!provider) return null

  if (provider.provider === 'openai') {
    const res = await fetch(`${provider.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.modelId,
        input: text.slice(0, 8191),
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const data = await res.json() as { data: Array<{ embedding: number[] }> }
    return { vector: data.data[0].embedding, modelRef: provider.modelId }
  }

  // Ollama: supports /api/embed endpoint (nomic-embed-text, bge-m3, etc.)
  const res = await fetch(`${provider.baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: provider.modelId, input: text }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) return null
  const data = await res.json() as { embedding: number[] }
  return { vector: data.embedding, modelRef: provider.modelId }
}

/**
 * Build the text to embed: title + content, capped for token limits.
 */
function buildEmbeddingText(note: { title: string; content: string }): string {
  const combined = `${note.title}\n\n${note.content}`.trim()
  // ~20K chars is safe for most embedding models
  return combined.length > 20000 ? combined.slice(0, 20000) + '...' : combined
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** Upsert an embedding for a note (replaces previous version). */
export async function storeEmbedding(
  noteId: string,
  vector: number[],
  modelRef: string,
): Promise<void> {
  await prisma.noteEmbedding.upsert({
    where: { noteId },
    update: {
      embedding: JSON.stringify(vector),
      dimension: vector.length,
      modelRef,
      version: { increment: 1 },
      updatedAt: new Date(),
    },
    create: {
      noteId,
      embedding: JSON.stringify(vector),
      dimension: vector.length,
      modelRef,
    },
  })
}

/**
 * Embed a single note: build text → generate embedding → store.
 * Returns true if embedding was generated successfully.
 */
export async function embedNote(note: {
  id: string
  title: string
  content: string
}): Promise<boolean> {
  const text = buildEmbeddingText(note)
  if (!text.trim()) return false

  const result = await generateEmbedding(text)
  if (!result) return false

  await storeEmbedding(note.id, result.vector, result.modelRef)
  return true
}

/**
 * Embed ALL notes. For initial backfill or re-embedding after a model change.
 */
export async function embedAllNotes(): Promise<{ embedded: number; failed: number }> {
  const notes = await prisma.note.findMany({
    select: { id: true, title: true, content: true },
  })

  let embedded = 0
  let failed = 0

  for (const note of notes) {
    try {
      const ok = await embedNote(note)
      if (ok) embedded++
      else failed++
      // Rate-limit: small delay between API calls
      await new Promise(r => setTimeout(r, 100))
    } catch {
      failed++
    }
  }

  return { embedded, failed }
}

// ── Vector Search ────────────────────────────────────────────────────────────

/**
 * Vector similarity search over note embeddings.
 * Uses pgvector's <-> operator (cosine distance) on the raw SQL level.
 *
 * @param queryVector - The embedding vector for the query
 * @param limit - Maximum results to return
 * @returns Notes ranked by similarity score (descending)
 */
export async function vectorSearch(
  queryVector: number[],
  limit: number = 10,
): Promise<
  Array<{
    noteId: string
    title: string
    content: string
    type: string
    folder: string
    pinned: boolean
    score: number
  }>
> {
  const vecStr = `[${queryVector.join(',')}]`

  const results = await prisma.$queryRaw<unknown[]>`
    SELECT
      ne."noteId",
      n."title",
      n.content,
      n."type",
      n.folder,
      n.pinned,
      (1 - (ne.embedding::vector <-> ${vecStr}::vector))::float AS score
    FROM "note_embeddings" ne
    JOIN "Note" n ON n.id = ne."noteId"
    WHERE ne.embedding IS NOT NULL
    ORDER BY score DESC
    LIMIT ${limit}
  `

  return (results as any[]).map(r => ({
    noteId: r.noteId as string,
    title: r.title as string,
    content: r.content as string,
    type: r.type as string,
    folder: r.folder as string,
    pinned: Boolean(r.pinned),
    score: parseFloat(r.score as string),
  }))
}

// ── Semantic Connections ─────────────────────────────────────────────────────

/**
 * Find semantically related notes for a given note and store as edges.
 * Called after embedding to keep the graph up-to-date.
 */
export async function computeSemanticEdges(
  noteId: string,
  topN: number = 5,
): Promise<void> {
  const target = await prisma.noteEmbedding.findUnique({ where: { noteId } })
  if (!target) return

  // target.embedding is already stored as a JSON array string like [-0.1, 0.5, ...]
  const vecStr = target.embedding

  const similar = await prisma.$queryRaw<
    Array<{ targetNoteId: string; score: number }>
  >`
    SELECT
      other."noteId" AS "targetNoteId",
      (1 - (other.embedding::vector <-> ${vecStr}::vector))::float AS score
    FROM "note_embeddings" other
    WHERE other."noteId" != ${noteId}
      AND other.embedding IS NOT NULL
    ORDER BY score DESC
    LIMIT ${topN}
  `

  for (const row of similar) {
    await prisma.semanticConnection.upsert({
      where: {
        sourceNoteId_targetNoteId: {
          sourceNoteId: noteId,
          targetNoteId: row.targetNoteId,
        },
      },
      update: { score: row.score },
      create: {
        sourceNoteId: noteId,
        targetNoteId: row.targetNoteId,
        score: row.score,
      },
    })
  }
}

// ── RAG Context Retrieval ─────────────────────────────────────────────────────

/**
 * Retrieve the most semantically relevant notes for a query.
 * Returns a formatted markdown block ready to append to a system prompt.
 * Returns empty string silently on any error (no embedding provider, pgvector
 * not installed, no notes embedded, etc.) so it never blocks an LLM call.
 */
export async function retrieveKnowledgeContext(
  query: string,
  topK = 3,
  minScore = 0.4,
): Promise<string> {
  try {
    const result = await generateEmbedding(query.slice(0, 2000))
    if (!result) return ''

    const hits = await vectorSearch(result.vector, topK)
    const relevant = hits.filter(h => h.score >= minScore)
    if (relevant.length === 0) return ''

    return relevant
      .map(h => {
        const typeTag = h.type !== 'note' ? ` [${h.type}]` : ''
        const body = h.content.length > 1500
          ? h.content.slice(0, 1500) + '\n[…]'
          : h.content
        return `### ${h.title}${typeTag}\n${body}`
      })
      .join('\n\n')
  } catch {
    return ''
  }
}

/**
 * Compute semantic edges for ALL notes. For initial backfill.
 */
export async function computeAllSemanticEdges(topN: number = 5): Promise<{
  computed: number
  failed: number
}> {
  const embeddings = await prisma.noteEmbedding.findMany({
    select: { noteId: true },
  })

  let computed = 0
  let failed = 0

  for (const emb of embeddings) {
    try {
      await computeSemanticEdges(emb.noteId, topN)
      computed++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`computeSemanticEdges(${emb.noteId}) failed: ${msg}`)
      failed++
    }
  }

  return { computed, failed }
}
