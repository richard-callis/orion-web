/**
 * POST /api/monitoring/security/actions
 *
 * Execute a security action through the action-service decision layer.
 *
 * This replaces the old route that directly called gateway tools.
 * The new route delegates to action-service.decide() and action-service.execute().
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { decide, execute, gatewayExecutor } from '@/lib/security/action-service'
import { type ActionRequest } from '@/lib/security/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  try {
    const body = await req.json()
    const request = body as ActionRequest

    // Validate required fields
    if (!request.actionType || !request.target || !request.reason) {
      return NextResponse.json({ error: 'Missing required fields: actionType, target, reason' }, { status: 400 })
    }

    // Check panic mode
    const panicModePolicy = await prisma.actionPolicy.findUnique({
      where: { actionType: '__panic_mode__' },
    })
    const panicMode = panicModePolicy?.defaultTier === 'approve'

    // Decide tier
    const decision = await decide(request, panicMode)

    // Call execute() for ALL tiers — it creates the ActionAudit row (R9) and
    // routes correctly: auto→gateway, approve/escalate→pending queue entry,
    // notify→audit-only. Without this, approve/escalate tiers returned early
    // with no DB row, leaving the approval queue permanently empty.
    const result = await execute(request, decision, gatewayExecutor)

    return NextResponse.json({
      pending: result.status === 'pending',
      success: result.status === 'succeeded',
      status: result.status,
      auditId: result.auditId,
      result: result.result,
      message: result.status === 'pending'
        ? `Action queued for ${decision.tier === 'escalate' ? 'escalation' : 'approval'}`
        : undefined,
    })
  } catch (err) {
    return NextResponse.json({ error: `Action failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 })
  }
}
