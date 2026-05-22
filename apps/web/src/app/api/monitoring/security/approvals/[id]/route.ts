/**
 * POST /api/monitoring/security/approvals/[id]
 *
 * Approve or deny a pending action approval request.
 *
 * Body:
 *   { action: 'approve' | 'deny', note?: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  action: z.enum(['approve', 'deny']),
  note: z.string().optional(),
})

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  // Approve/deny is a tier-elevation action — only admins. Without this check
  // anyone reachable on the network can execute pending privileged actions.
  let approver: { id: string; username: string }
  try {
    const user = await requireAdmin()
    approver = { id: user.id, username: user.username }
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = bodySchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body: action must be "approve" or "deny"' }, { status: 400 })
  }

  const { action, note } = parsed.data
  const auditId = params.id

  // Look up the pending audit row
  const audit = await prisma.actionAudit.findUnique({
    where: { id: auditId },
    select: {
      id: true,
      actionType: true,
      target: true,
      tier: true,
      status: true,
      incidentId: true,
      payload: true,
      environmentId: true,
    },
  })

  if (!audit) {
    return NextResponse.json({ error: 'Approval not found' }, { status: 404 })
  }

  if (audit.status !== 'pending') {
    return NextResponse.json({ error: 'Action is not pending approval' }, { status: 409 })
  }

  if (audit.tier !== 'approve') {
    return NextResponse.json({ error: 'Action tier is not approvable' }, { status: 400 })
  }

  // Update the audit row.
  // approvedBy is the resolved admin username — never the literal 'operator',
  // which would defeat the audit trail (M3/M8).
  const approverLabel = approver.username
  const updated = await prisma.actionAudit.update({
    where: { id: auditId },
    data: {
      status: action === 'approve' ? 'attempting' : 'denied',
      approvedBy: approverLabel,
    },
    include: {
      incident: {
        select: { id: true, attackerKey: true, rootCauseSummary: true },
      },
    },
  })

  if (action === 'approve') {
    // If auto-executable, mark as succeeded immediately
    // Actual execution is handled by the action executor
    // For now, mark as attempting and let the executor pick it up
    await prisma.actionAudit.update({
      where: { id: auditId },
      data: {
        status: 'attempting',
        result: note ?? null,
      },
    })
  } else {
    await prisma.actionAudit.update({
      where: { id: auditId },
      data: {
        status: 'denied',
        result: `Denied by operator: ${note ?? 'No reason provided'}`,
      },
    })
  }

  return NextResponse.json({
    success: true,
    id: auditId,
    status: action === 'approve' ? 'attempting' : 'denied',
  })
}
