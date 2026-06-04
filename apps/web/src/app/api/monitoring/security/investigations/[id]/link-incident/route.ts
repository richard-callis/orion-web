/**
 * POST /api/monitoring/security/investigations/[id]/link-incident
 *
 * Link an existing incident to an investigation.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { recordAudit } from '../../_utils'

export const dynamic = 'force-dynamic'

const linkSchema = z.object({
  incidentId: z.string().uuid(),
})

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const id = (await params).id
  const body = linkSchema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const { incidentId } = body.data

  const [investigation, incident] = await Promise.all([
    prisma.investigation.findUnique({ where: { id } }),
    prisma.incident.findUnique({ where: { id: incidentId } }),
  ])

  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }
  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }
  if (incident.investigationId && incident.investigationId !== id) {
    return NextResponse.json({ error: 'Incident already linked to another investigation' }, { status: 409 })
  }

  await prisma.incident.update({
    where: { id: incidentId },
    data: { investigationId: id },
  })

  await recordAudit(id, 'admin', 'human', 'link_added',
    undefined, { incidentId })

  await prisma.investigationTimeline.create({
    data: {
      investigationId: id, eventTime: new Date(),
      eventType: 'link_added',
      title: `Incident linked: ${incident.attackerKey ?? incident.id}`,
      source: 'manual',
    },
  })

  return NextResponse.json({ ok: true, incidentId })
}
