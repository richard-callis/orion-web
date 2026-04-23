/**
 * POST /api/notes/embed/rebuild
 *
 * Regenerate embeddings for all notes and recompute semantic connections.
 * This is a batch operation that may take several minutes for large note sets.
 * Triggered by the MCP tool knowledge_embed_all.
 */

import { NextRequest, NextResponse } from 'next/server'
import { embedAllNotes, computeAllSemanticEdges } from '@/lib/embeddings'
import { getServerSession } from 'next-auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Auth check — allow session, OR an embed trigger token set via env
  const session = await getServerSession()
  const embedToken = process.env.EMBED_TRIGGER_TOKEN
  const headers = req.headers
  const hasToken = embedToken && headers.get('x-embed-token') === embedToken
  if (!session && !hasToken) {
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
