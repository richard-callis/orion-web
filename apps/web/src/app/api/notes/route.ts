import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { embedNote } from '@/lib/embeddings'
import { getCurrentUser } from '@/lib/auth'

export async function GET(req: NextRequest) {
  // SOC2: [H-004] No authentication — any unauthenticated user can read all notes.
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const notes = await prisma.note.findMany({
    where: type ? { type } : undefined,
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
  })
  return NextResponse.json(notes)
}

export async function POST(req: NextRequest) {
  // SOC2: [H-004] No authentication — any unauthenticated user can create notes.
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const note = await prisma.note.create({
    data: {
      title:   body.title,
      content: body.content ?? '',
      folder:  body.folder  ?? 'General',
      pinned:  body.pinned  ?? false,
      type:    body.type    ?? 'note',
      tags:    body.tags    ?? null,
    },
  })

  // Embed asynchronously — don't block the response
  embedNote(note).catch(err => console.error('[embed] failed for new note:', err))

  return NextResponse.json(note, { status: 201 })
}
