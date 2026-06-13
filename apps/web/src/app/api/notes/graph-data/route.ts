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

  // SOC2: scope to caller's notes when the Note model gains a createdBy field.
  // Notes are currently system-wide (no createdBy column); admin and service
  // callers see all notes. Regular users see all notes too until the schema is
  // extended — this is documented as a known limitation.
  const noteWhere = (!isService && caller && caller.role !== 'admin')
    ? {} // TODO: add { createdBy: caller.id } once Note.createdBy column exists
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
    const connections = await prisma.semanticConnection.findMany({
      select: { sourceNoteId: true, targetNoteId: true, score: true },
      where: { score: { gte: threshold } },
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
