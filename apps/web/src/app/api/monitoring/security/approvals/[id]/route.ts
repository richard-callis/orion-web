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
import { gatewayExecutor } from '@/lib/security/action-service'
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
  let approver: { id: string; username: string }
  try {
    const user = await requireAdmin()
    approver = { id: user.id, username: user.username }
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let rawBody: unknown
  try { rawBody = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body: action must be "approve" or "deny"' }, { status: 400 })
  }

  const { action, note } = parsed.data
  const auditId = params.id

  // Fetch audit row to get action details for execution
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

  if (!audit) return NextResponse.json({ error: 'Approval not found' }, { status: 404 })
  if (audit.tier !== 'approve') return NextResponse.json({ error: 'Action tier is not approvable' }, { status: 400 })

  // Atomic CAS: only transition if still pending. Prevents double-execution
  // when two operators approve concurrently (M2 — TOCTOU race).
  const cas = await prisma.actionAudit.updateMany({
    where: { id: auditId, status: 'pending' },
    data: {
      status: action === 'approve' ? 'attempting' : 'denied',
      approvedBy: approver.username,
      result: action === 'deny' ? `Denied by operator: ${note ?? 'No reason provided'}` : null,
    },
  })

  if (cas.count === 0) {
    // Another request already transitioned it
    return NextResponse.json({ error: 'Action is not pending (already processed or concurrent modification)' }, { status: 409 })
  }

  if (action === 'deny') {
    return NextResponse.json({ success: true, id: auditId, status: 'denied' })
  }

  // Execute the approved action via the gateway (B1 fix — was a dead end before)
  try {
    const { success, result } = await gatewayExecutor(
      {
        actionType: audit.actionType,
        target: audit.target,
        reason: note ?? 'Approved by operator',
        payload: audit.payload as Record<string, unknown> | null,
        incidentId: audit.incidentId,
      },
      audit.target,
      audit.payload as Record<string, unknown> | undefined,
      audit.environmentId
    )

    await prisma.actionAudit.update({
      where: { id: auditId },
      data: { status: success ? 'succeeded' : 'failed', result },
    })

    return NextResponse.json({ success, id: auditId, status: success ? 'succeeded' : 'failed', result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.actionAudit.update({
      where: { id: auditId },
      data: { status: 'failed', result: msg },
    })
    return NextResponse.json({ success: false, id: auditId, status: 'failed', result: msg })
  }
}
