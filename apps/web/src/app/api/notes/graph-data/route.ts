/**
 * GET /api/notes/graph-data
 *
 * Returns nodes and links for the knowledge graph visualization.
 * Links include both [[wikilink]] edges and semantic (vector-similarity) edges.
 *
 * Query params:
 *   includeSemantic=true|false — include semantic edges (default: true)
 *   threshold=0.XX — minimum similarity score for semantic edges (default: 0.5)
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeOutgoingEdges } from '@/lib/wiki-links'
import { requireServiceAuth } from '@/lib/auth'

interface NoteRow {
  id: string
  title: string
  content: string | null
  type: string
  folder: string
  pinned: boolean
}

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null
  const { searchParams } = new URL(req.url)
  const includeSemantic = searchParams.get('includeSemantic') !== 'false'
  const threshold = parseFloat(searchParams.get('threshold') ?? '0.5') || 0.5

  // SOC2: scope notes for non-admin session callers to "mine OR shared (null)".
  // Admin and service/gateway callers see all notes.
  const noteWhere = (!isService && caller && caller.role !== 'admin')
    ? { OR: [{ createdBy: caller.id }, { createdBy: null }] }
    : {}

  const notes = await prisma.note.findMany({
    where: Object.keys(noteWhere).length ? noteWhere : undefined,
    orderBy: { updatedAt: 'desc' },
    take: 2000,
  })

  const nodes = notes.map((n: any) => ({
    id: n.id,
    title: n.title,
    type: n.type,
    folder: n.folder,
    pinned: n.pinned,
  }))

  // Wikilink edges (existing)
  const wikilinkEdges = computeOutgoingEdges(
    notes.map((n: any) => ({ id: n.id, title: n.title, content: n.content ?? '' })),
  ).map(e => ({
    source: e.source,
    target: e.target,
    type: 'wikilink',
  }))

  // Semantic edges (new)
  let semanticLinks: Array<{ source: string; target: string; type: 'semantic'; score: number }> = []
  if (includeSemantic) {
    // SOC2: scope edges to notes already in the (possibly caller-scoped)
    // `notes` set above — otherwise an edge to/from a note the caller can't
    // see would leak that note's id even though its title/content stay hidden.
    const noteIds = notes.map((n: any) => n.id)
    const connections = await prisma.semanticConnection.findMany({
      select: { sourceNoteId: true, targetNoteId: true, score: true },
      where: { score: { gte: threshold }, sourceNoteId: { in: noteIds }, targetNoteId: { in: noteIds } },
      orderBy: { score: 'desc' },
      take: 5000,
    })
    semanticLinks = connections.map((c: any) => ({
      source: c.sourceNoteId,
      target: c.targetNoteId,
      type: 'semantic',
      score: c.score,
    }))
  }

  const links = [...wikilinkEdges, ...semanticLinks]

  return NextResponse.json({ nodes, links, counts: { wikilinks: wikilinkEdges.length, semantic: semanticLinks.length } })
}
