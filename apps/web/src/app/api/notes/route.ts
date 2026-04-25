import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { embedNote } from '@/lib/embeddings'
import { requireServiceAuth } from '@/lib/auth'
import { CreateNoteSchema } from '@/lib/validate'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const notes = await prisma.note.findMany({
    where: type ? { type } : undefined,
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
  })
  return NextResponse.json(notes)
}

export async function POST(req: NextRequest) {
  await requireServiceAuth(req)

  // SOC2: Input validation — validate and sanitize all request body fields
  const rawBody = await req.json().catch(() => ({}))
  const body = typeof rawBody === 'object' && rawBody !== null ? rawBody : {}

  const parsed = CreateNoteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })) },
      { status: 400 },
    )
  }

  const note = await prisma.note.create({
    data: {
      title:   parsed.data.title,
      content: parsed.data.content,
      folder:  parsed.data.folder,
      pinned:  parsed.data.pinned,
      type:    parsed.data.type,
      tags:    parsed.data.tags,
    },
  })

  // Embed asynchronously — don't block the response
  embedNote(note).catch(err => console.error('[embed] failed for new note:', err))

  return NextResponse.json(note, { status: 201 })
}
