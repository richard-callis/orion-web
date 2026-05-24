/**
 * POST /api/monitoring/security/investigations/[id]/notes
 *
 * Add a note to an investigation.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { recordAudit, updateSearchVector } from '../../_utils'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  content: z.string().min(1),
  author: z.string().default('admin'),
  authorType: z.enum(['human', 'warden']).default('human'),
  isDraft: z.boolean().default(false),
})

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const id = (await params).id
  const body = createSchema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const { content, author, authorType, isDraft } = body.data

  // Warden cannot create draft notes
  if (authorType === 'warden' && isDraft) {
    return NextResponse.json({ error: 'Warden cannot create draft notes' }, { status: 403 })
  }

  const investigation = await prisma.investigation.findUnique({ where: { id } })
  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  const note = await prisma.investigationNote.create({
    data: { investigationId: id, content, author, authorType, isDraft },
  })

  // Update the tsvector search index
  await updateSearchVector(note.id, content)

  await recordAudit(id, author, authorType, 'note_added', undefined, { noteId: note.id })

  await prisma.investigationTimeline.create({
    data: {
      investigationId: id, eventTime: new Date(),
      eventType: 'note_added',
      title: `${authorType === 'warden' ? 'Warden' : 'Analyst'} note added`,
      description: isDraft ? '(draft)' : undefined,
      source: authorType === 'warden' ? 'warden' : 'manual',
    },
  })

  return NextResponse.json(note, { status: 201 })
}
