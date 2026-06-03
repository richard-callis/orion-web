/**
 * GET /api/monitoring/security/investigations/[id]
 * PATCH /api/monitoring/security/investigations/[id]
 * DELETE /api/monitoring/security/investigations/[id]
 *
 * Full investigation detail, update fields, archive (soft-close).
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { recordAudit } from '../_utils'

export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['open', 'active', 'suspended', 'resolved', 'closed']).optional(),
  severity: z.number().int().min(0).max(100).optional(),
  tlp: z.enum(['white', 'green', 'amber', 'red']).optional(),
  resolution: z.string().optional().nullable(),
  resolutionType: z.enum(['true_positive', 'false_positive', 'benign', 'inconclusive']).optional().nullable(),
  assignedTo: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  mitreAttackIds: z.array(z.string()).optional(),
  dueAt: z.string().datetime().optional().nullable(),
})

// ─── Warden constraints ─────────────────────────────────────────────────────

const WARDEN_ALLOWED_STATUS = new Set(['open', 'active', 'suspended'])

function applyWardenConstraints(
  actor: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (actor !== 'warden') return data
  const clean = { ...data }
  if (clean.status && !WARDEN_ALLOWED_STATUS.has(clean.status as string)) {
    throw new Error('Warden cannot transition investigation to resolved or closed')
  }
  delete clean.resolutionType
  return clean
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = (await params).id

  const investigation = await prisma.investigation.findUnique({
    where: { id },
    include: {
      incidents: { orderBy: { openedAt: 'desc' }, take: 50 },
      notes: { orderBy: { createdAt: 'desc' }, take: 100 },
      observables: { orderBy: { firstSeen: 'desc' }, take: 200 },
      timeline: { orderBy: { eventTime: 'asc' }, take: 200 },
    },
  })

  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  return NextResponse.json({
    investigation: {
      ...investigation,
      incidents: investigation.incidents.map(i => ({
        id: i.id, status: i.status, severity: i.severity,
        attackerKey: i.attackerKey, hostKey: i.hostKey, openedAt: i.openedAt,
        rootCauseSummary: i.rootCauseSummary,
      })),
    },
  })
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const id = (await params).id
  const raw = await req.json()
  const parsed = updateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 })
  }

  const existing = await prisma.investigation.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  const actor = raw._actor ?? 'admin'
  let data = applyWardenConstraints(actor, parsed.data)

  // Set resolvedAt/closedAt on status transition
  if (data.status === 'resolved' && !existing.resolvedAt) {
    data = { ...data, resolvedAt: new Date() }
  }
  if (data.status === 'closed' && !existing.closedAt) {
    data = { ...data, closedAt: new Date() }
  }

  const before = { ...existing }
  const updated = await prisma.investigation.update({
    where: { id },
    data,
  })

  await recordAudit(id, actor, 'human', 'status_changed', before, updated)

  // Timeline entry
  if (data.status) {
    await prisma.investigationTimeline.create({
      data: {
        investigationId: id, eventTime: new Date(),
        eventType: 'status_changed',
        title: `Status: ${existing.status} → ${data.status}`,
        source: actor === 'warden' ? 'warden' : 'manual',
      },
    })
  }

  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const id = (await params).id

  const existing = await prisma.investigation.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  if (existing.status === 'closed') {
    return NextResponse.json({ error: 'Already closed' }, { status: 409 })
  }

  const updated = await prisma.investigation.update({
    where: { id },
    data: { status: 'closed', closedAt: new Date() },
  })

  await prisma.investigationTimeline.create({
    data: {
      investigationId: id, eventTime: new Date(),
      eventType: 'status_changed', title: 'Investigation closed',
      source: 'manual',
    },
  })

  return NextResponse.json(updated)
}
