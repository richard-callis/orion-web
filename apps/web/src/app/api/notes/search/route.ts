/**
 * POST /api/notes/search
 *
 * Semantic search over notes. Generates an embedding for the query text,
 * then returns the top-K most similar notes by cosine similarity.
 * Used by MCP gateway tools for knowledge_search.
 */

import { NextRequest, NextResponse } from 'next/server'
import { hybridSearch } from '@/lib/embeddings'
import { requireServiceAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null
  const body = await req.json()
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  const limit = Math.min(Math.max(parseInt(body.limit ?? '10', 10) || 10, 1), 50)
  const includeContent = body.includeContent !== false // default true

  if (!query) {
    return NextResponse.json({ error: 'Query is required' }, { status: 400 })
  }

  // SOC2: mirror the rest of the notes API's ownership scoping
  // (scopeByCreatedBy in /api/notes, guardAccess in /api/notes/[id]) — the
  // service/gateway and admins search everything, any other logged-in user
  // is restricted to their own notes plus unowned/shared ones.
  const callerId = isService || caller.role === 'admin' ? undefined : caller.id

  try {
    // Hybrid search: dense pgvector cosine search + Postgres full-text
    // search, fused via RRF. Falls back to keyword-only if no embedding
    // provider is configured (model is then null in the response below).
    const { modelRef, hits } = await hybridSearch(query, limit, callerId)

    // Trim content if includeContent is false
    const results = includeContent
      ? hits
      : hits.map(n => ({ ...n, content: n.content.slice(0, 500) }))

    return NextResponse.json({
      query,
      model: modelRef,
      results,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
