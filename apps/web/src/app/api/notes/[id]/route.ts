import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { embedNote } from '@/lib/embeddings'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError, UpdateNoteSchema } from '@/lib/validate'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const note = await prisma.note.findUnique({ where: { id: params.id } })
  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(note)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, UpdateNoteSchema)
  if ('error' in result) return result.error
  const { data } = result

  const updateData: Record<string, unknown> = {}
  const isContentChange = data.content !== undefined
  const isTitleChange = data.title !== undefined

  if (data.title   !== undefined) updateData.title   = data.title
  if (data.content !== undefined) updateData.content = data.content
  if (data.folder  !== undefined) updateData.folder  = data.folder
  if (data.pinned  !== undefined) updateData.pinned  = data.pinned
  if (data.type    !== undefined) updateData.type    = data.type
  if (data.tags    !== undefined) updateData.tags    = data.tags || null

  const note = await prisma.note.update({ where: { id: params.id }, data: updateData })

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
