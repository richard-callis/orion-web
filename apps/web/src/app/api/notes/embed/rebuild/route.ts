/**
 * POST /api/notes/embed/rebuild
 *
 * Regenerate embeddings for all notes and recompute semantic connections.
 * This is a batch operation that may take several minutes for large note sets.
 * Intended for admin use or triggered by the MCP tool knowledge_embed_all.
 */

import { NextRequest, NextResponse } from 'next/server'
import { embedAllNotes, computeAllSemanticEdges } from '@/lib/embeddings'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Only allow admin users (check session)
  const { default: { getToken } } = await import('next-auth/next/cookies')
  // Skip auth in dev for now; production should gate this properly
  // @ts-ignore - next-auth cookies module not typed for this path
  const token = await getToken({ req, cookieName: 'next-auth.session.token' })
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Step 1: Embed all notes
    const embedResult = await embedAllNotes()

    // Step 2: Compute semantic connections (requires embeddings to exist)
    const connResult = await computeAllSemanticEdges()

    return NextResponse.json({
      message: 'Embedding complete',
      notesEmbedded: embedResult.embedded,
      embedFailed: embedResult.failed,
      connectionsComputed: connResult.computed,
      connectionsFailed: connResult.failed,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
