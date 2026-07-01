/**
 * POST /api/monitoring/security/containment/[id]/reject
 *
 * Phase 4 containment: an admin rejects a pending ContainmentRequest.
 * Idempotent — only a request still in 'pending' is transitioned.
 * The linked incident status is left unchanged.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let admin
  try { admin = await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params

  const request = await prisma.containmentRequest.findUnique({ where: { id } })
  if (!request) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Idempotency: only transition a request that is still pending.
  // updateMany + actionAudit.create in a single transaction — no partial state.
  const { count } = await prisma.$transaction(async (tx) => {
    const updateResult = await tx.containmentRequest.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'rejected', reviewedBy: admin.id, reviewedAt: new Date() },
    })
    if (updateResult.count === 0) return updateResult

    await tx.actionAudit.create({
      data: {
        incidentId: request.incidentId,
        actionType: 'containment_reject',
        target: request.incidentId,
        tier: 'approve',
        proposedBy: request.requestedBy,
        approvedBy: admin.id,
        status: 'denied',
        payload: { containmentRequestId: id, justification: request.justification } as any,
        result: `Containment rejected by ${admin.id}`,
      },
    })

    return updateResult
  })
  if (count === 0) {
    return NextResponse.json({ error: 'Containment request is not pending' }, { status: 409 })
  }

  logAudit({
    userId: admin.id,
    action: 'containment_reject',
    target: `incident:${request.incidentId}`,
    detail: { containmentRequestId: id, action: request.action },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  const updated = await prisma.containmentRequest.findUnique({ where: { id } })
  return NextResponse.json(updated, { status: 200 })
}
