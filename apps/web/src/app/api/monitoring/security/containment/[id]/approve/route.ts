/**
 * POST /api/monitoring/security/containment/[id]/approve
 *
 * Phase 4 containment: an admin approves a pending ContainmentRequest.
 * Idempotent — only a request still in 'pending' is transitioned.
 * On approval the linked incident is moved to 'contained'.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const { id } = await params

  const request = await prisma.containmentRequest.findUnique({ where: { id } })
  if (!request) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Idempotency: only transition a request that is still pending.
  const { count } = await prisma.containmentRequest.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'approved', reviewedBy: admin.id, reviewedAt: new Date() },
  })
  if (count === 0) {
    return NextResponse.json({ error: 'Containment request is not pending' }, { status: 409 })
  }

  await prisma.incident.update({
    where: { id: request.incidentId },
    data: { status: 'contained' },
  })

  await prisma.actionAudit.create({
    data: {
      incidentId: request.incidentId,
      actionType: 'containment_approve',
      target: request.incidentId,
      tier: 'approve',
      proposedBy: request.requestedBy,
      approvedBy: admin.id,
      status: 'succeeded',
      payload: { containmentRequestId: id, justification: request.justification } as any,
      result: `Containment approved by ${admin.id}`,
    },
  })

  logAudit({
    userId: admin.id,
    action: 'containment_approve',
    target: `incident:${request.incidentId}`,
    detail: { containmentRequestId: id, action: request.action },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  const updated = await prisma.containmentRequest.findUnique({ where: { id } })
  return NextResponse.json(updated, { status: 200 })
}
