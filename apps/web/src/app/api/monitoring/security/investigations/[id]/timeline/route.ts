/**
 * POST /api/monitoring/security/investigations/[id]/timeline
 *
 * Add a manual timeline entry.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { recordAudit } from '../../_utils'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  eventTime: z.string().datetime(),
  eventType: z.string(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  source: z.enum(['manual', 'warden', 'correlator', 'thehive']).default('manual'),
  isPinned: z.boolean().default(false),
  payload: z.record(z.unknown()).optional().nullable(),
})

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const id = (await params).id
  const body = createSchema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const investigation = await prisma.investigation.findUnique({ where: { id } })
  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  const entry = await prisma.investigationTimeline.create({
    data: {
      ...body.data,
      investigationId: id,
      eventTime: new Date(body.data.eventTime),
      payload: (body.data.payload ?? undefined) as import('@prisma/client').Prisma.InputJsonValue | undefined,
    },
  })

  const actor = body.data.source === 'warden' ? 'warden' : 'admin'
  await recordAudit(id, actor, body.data.source, 'action_taken',
    undefined, { timelineId: entry.id })

  return NextResponse.json(entry, { status: 201 })
}
