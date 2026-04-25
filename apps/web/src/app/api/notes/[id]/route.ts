import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { embedNote } from '@/lib/embeddings'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const note = await prisma.note.findUnique({ where: { id: params.id } })
  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(note)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const body = await req.json()
  const data: Record<string, unknown> = {}
  const isContentChange = body.content !== undefined
  const isTitleChange = body.title !== undefined

  if (body.title   !== undefined) data.title   = body.title
  if (body.content !== undefined) data.content = body.content
  if (body.folder  !== undefined) data.folder  = body.folder
  if (body.pinned  !== undefined) data.pinned  = body.pinned
  if (body.type    !== undefined) data.type    = body.type
  if (body.tags    !== undefined) data.tags    = body.tags || null

  const note = await prisma.note.update({ where: { id: params.id }, data })

  // Re-embed if content or title changed
  if (isContentChange || isTitleChange) {
    // Re-fetch with fresh data (the update may have returned a truncated row)
    const updated = await prisma.note.findUnique({ where: { id: params.id } })
    if (updated) {
      embedNote(updated).catch(err => console.error('[embed] failed for updated note:', err))
    }
  }

  return NextResponse.json(note)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  await prisma.note.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
