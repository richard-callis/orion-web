/**
 * GET /api/notes/graph-data
 *
 * Returns nodes and links for the knowledge graph visualization.
 * Links are derived from [[wikilink]] patterns in note content.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeOutgoingEdges } from '@/lib/wiki-links'

interface NoteRow {
  id: string
  title: string
  content: string | null
  type: string
  folder: string
  pinned: boolean
}

// Prevent static prerendering — needs database at request time
export const dynamic = 'force-dynamic'

export async function GET() {
  const notes: NoteRow[] = await prisma.note.findMany({
    orderBy: { updatedAt: 'desc' },
  })

  const nodes = notes.map(n => ({
    id: n.id,
    title: n.title,
    type: n.type,
    folder: n.folder,
    pinned: n.pinned,
  }))

  const edges = computeOutgoingEdges(
    notes.map(n => ({ id: n.id, title: n.title, content: n.content ?? '' })),
  )

  // Transform to react-force-graph-2d format (links)
  const links = edges.map(e => ({ source: e.source, target: e.target }))

  return NextResponse.json({ nodes, links })
}
