/**
 * POST /api/admin/knowledge-search
 *
 * Admin-only debugging tool: run an ad-hoc hybrid search against the Note
 * knowledge base and see exactly what pops up, including the per-leg
 * (vector / keyword) score breakdown behind the fused ranking. Backs the
 * admin panel's Knowledge Search page.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { hybridSearch } from '@/lib/embeddings'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  await requireAdmin()

  const body = await req.json().catch(() => ({}))
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  const limit = Math.min(Math.max(parseInt(body.limit ?? '10', 10) || 10, 1), 50)

  if (!query) {
    return NextResponse.json({ error: 'Query is required' }, { status: 400 })
  }

  const { modelRef, hits } = await hybridSearch(query, limit)

  return NextResponse.json({
    query,
    modelRef,
    results: hits.map(h => ({
      noteId:       h.noteId,
      title:        h.title,
      type:         h.type,
      folder:       h.folder,
      pinned:       h.pinned,
      snippet:      h.content.slice(0, 300),
      score:        h.score,
      vectorScore:  h.vectorScore,
      keywordScore: h.keywordScore,
    })),
  })
}
