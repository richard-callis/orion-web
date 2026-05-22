/**
 * GET /api/monitoring/security/approvals
 *
 * List pending action approvals — actions that need human approval
 * before execution (tier 'approve' without approvedBy).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const envId = req.nextUrl.searchParams.get('env') || process.env.ENVIRONMENT_ID || ''

  const pending = await prisma.actionAudit.findMany({
    where: {
      environmentId: envId || null,
      status: 'pending',
      tier: 'approve',
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true,
      actionType: true,
      target: true,
      tier: true,
      proposedBy: true,
      incidentId: true,
      payload: true,
      createdAt: true,
      incident: {
        select: {
          severity: true,
          rootCauseSummary: true,
          attackerKey: true,
        },
      },
    },
  })

  return NextResponse.json({
    pending: pending.map(a => ({
      id: a.id,
      actionType: a.actionType,
      target: a.target,
      tier: a.tier,
      proposedBy: a.proposedBy,
      incidentId: a.incidentId,
      payload: a.payload,
      createdAt: a.createdAt,
      incident: a.incident
        ? {
            severity: a.incident.severity,
            summary: a.incident.rootCauseSummary ?? null,
            attackerKey: a.incident.attackerKey ?? null,
          }
        : null,
    })),
    count: pending.length,
  })
}
