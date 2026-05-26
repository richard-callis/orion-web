/**
 * PATCH /api/monitoring/security/investigations/[id]/observables/[obsId]
 * DELETE /api/monitoring/security/investigations/[id]/observables/[obsId]
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { recordAudit } from '../../../_utils'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  verdict: z.enum(['malicious', 'suspicious', 'benign', 'unknown']).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  resolved: z.boolean().optional(),
  context: z.string().optional().nullable(),
  role: z.enum(['ioc', 'artifact', 'infrastructure']).optional(),
})

export async function PATCH(req: Request, { params }: { params: { id: string; obsId: string } }) {
  const { id, obsId } = await params
  const raw = await req.json()
  const body = updateSchema.safeParse(raw)
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const actor = raw._actor ?? 'admin'

  const observable = await prisma.investigationObservable.findUnique({ where: { id: obsId } })
  if (!observable || observable.investigationId !== id) {
    return NextResponse.json({ error: 'Observable not found' }, { status: 404 })
  }

  // Warden constraint: cannot set malicious with confidence < 80
  if (
    actor === 'warden' &&
    body.data.verdict === 'malicious' &&
    (body.data.confidence ?? observable.confidence) < 80
  ) {
    return NextResponse.json(
      { error: 'Warden requires confidence >= 80 to set malicious verdict' },
      { status: 403 },
    )
  }

  const before = { ...observable }
  const updated = await prisma.investigationObservable.update({
    where: { id: obsId },
    data: {
      ...body.data,
      verdictBy: body.data.verdict ? actor : undefined,
      verdictAt: body.data.verdict ? new Date() : undefined,
    },
  })

  await recordAudit(id, actor, actor === 'warden' ? 'warden' : 'human',
    'observable_added', before, updated)

  if (body.data.verdict) {
    await prisma.investigationTimeline.create({
      data: {
        investigationId: id, eventTime: new Date(),
        eventType: 'observable_verdict_set',
        title: `Verdict: ${observable.value} → ${body.data.verdict}`,
        source: actor === 'warden' ? 'warden' : 'manual',
      },
    })
  }

  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: { id: string; obsId: string } }) {
  const { id, obsId } = await params

  const observable = await prisma.investigationObservable.findUnique({ where: { id: obsId } })
  if (!observable || observable.investigationId !== id) {
    return NextResponse.json({ error: 'Observable not found' }, { status: 404 })
  }

  await prisma.investigationObservable.delete({ where: { id: obsId } })
  await recordAudit(id, 'admin', 'human', 'observable_deleted', { observableId: obsId }, undefined)

  return NextResponse.json({ ok: true })
}
