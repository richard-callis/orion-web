/**
 * POST /api/notes/search
 *
 * Semantic search over notes. Generates an embedding for the query text,
 * then returns the top-K most similar notes by cosine similarity.
 * Used by MCP gateway tools for knowledge_search.
 */

import { NextRequest, NextResponse } from 'next/server'
import { generateEmbedding, vectorSearch } from '@/lib/embeddings'
import { requireServiceAuth } from '@/lib/auth'
import { sanitizeError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  await requireServiceAuth(req)
  const body = await req.json()
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  const limit = Math.min(Math.max(parseInt(body.limit ?? '10', 10) || 10, 1), 50)
  const includeContent = body.includeContent !== false // default true

  if (!query) {
    return NextResponse.json({ error: 'Query is required' }, { status: 400 })
  }

  try {
    // Generate embedding for the query
    const result = await generateEmbedding(query)
    if (!result) {
      return NextResponse.json(
        { error: 'No embedding provider configured. Add an OpenAI or Ollama model in ExternalModels.' },
        { status: 503 },
      )
    }

    // Vector search
    const notes = await vectorSearch(result.vector, limit)

    // Trim content if includeContent is false
    const results = includeContent
      ? notes
      : notes.map(n => ({ ...n, content: n.content.slice(0, 500) }))

    return NextResponse.json({
      query,
      model: result.modelRef,
      results,
    })
  } catch (err) {
    const msg = sanitizeError(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
