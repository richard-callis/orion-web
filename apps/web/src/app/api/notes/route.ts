import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { embedNote } from '@/lib/embeddings'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const notes = await prisma.note.findMany({
    where: type ? { type } : undefined,
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
  })
  return NextResponse.json(notes)
}

export async function POST(req: NextRequest) {
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
