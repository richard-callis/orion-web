/**
 * PATCH /api/monitoring/security/investigations/[id]/notes/[noteId]
 * DELETE /api/monitoring/security/investigations/[id]/notes/[noteId]
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { recordAudit, updateSearchVector } from '../../../_utils'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  content: z.string().min(1).optional(),
  isDraft: z.boolean().optional(),
})

export async function PATCH(req: Request, { params }: { params: { id: string; noteId: string } }) {
  const { id, noteId } = await params
  const body = updateSchema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const note = await prisma.investigationNote.findUnique({ where: { id: noteId } })
  if (!note || note.investigationId !== id) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 })
  }

  // Warden cannot edit human-authored notes
  const raw = await req.json()
  const actor = (raw as any)._actor ?? 'admin'
  if (actor === 'warden' && note.authorType === 'human') {
    return NextResponse.json({ error: 'Warden cannot edit human-authored notes' }, { status: 403 })
  }

  const before = { ...note }
  const updated = await prisma.investigationNote.update({
    where: { id: noteId },
    data: body.data,
  })

  // Update search vector if content changed
  if (body.data.content) {
    await updateSearchVector(noteId, body.data.content)
  }

  await recordAudit(id, actor, actor === 'warden' ? 'warden' : 'human', 'note_added', before, updated)

  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: { id: string; noteId: string } }) {
  const { id, noteId } = await params

  const note = await prisma.investigationNote.findUnique({ where: { id: noteId } })
  if (!note || note.investigationId !== id) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 })
  }

  await prisma.investigationNote.delete({ where: { id: noteId } })
  await recordAudit(id, 'admin', 'human', 'note_added', { noteId }, null)

  return NextResponse.json({ ok: true })
}
