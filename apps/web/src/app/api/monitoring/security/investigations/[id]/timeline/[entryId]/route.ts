/**
 * PATCH /api/monitoring/security/investigations/[id]/timeline/[entryId]
 *
 * Pin/unpin or edit description of a timeline entry.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  isPinned: z.boolean().optional(),
  description: z.string().optional().nullable(),
})

export async function PATCH(req: Request, { params }: { params: { id: string; entryId: string } }) {
  const { id, entryId } = await params
  const body = updateSchema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const entry = await prisma.investigationTimeline.findUnique({ where: { id: entryId } })
  if (!entry || entry.investigationId !== id) {
    return NextResponse.json({ error: 'Timeline entry not found' }, { status: 404 })
  }

  const updated = await prisma.investigationTimeline.update({
    where: { id: entryId },
    data: body.data,
  })

  return NextResponse.json(updated)
}
