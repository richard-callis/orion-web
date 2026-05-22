/**
 * POST /api/monitoring/security/actions
 *
 * Execute a security action through the action-service decision layer.
 *
 * This replaces the old route that directly called gateway tools.
 * The new route delegates to action-service.decide() and action-service.execute().
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { decide, execute } from '@/lib/security/action-service'
import { type ActionRequest } from '@/lib/security/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Gateway executor — calls the gateway's tool execution endpoint.
 */
async function gatewayExecutor(
  action: ActionRequest,
  target: string,
  payload: Record<string, unknown> | undefined
): Promise<{ success: boolean; result: string }> {
  const gatewayUrl = process.env.GATEWAY_URL
  const gatewayToken = process.env.GATEWAY_TOKEN

  if (!gatewayUrl || !gatewayToken) {
    return { success: false, result: 'Gateway not configured' }
  }

  let toolName = ''
  let toolArgs: Record<string, unknown> = {}

  switch (action.actionType) {
    case 'crowdsec_decision_create':
      toolName = 'crowdsec_decision_create'
      toolArgs = { ip: target, reason: payload?.reason as string ?? 'Blocked via ORION' }
      break
    case 'crowdsec_decision_delete':
      toolName = 'crowdsec_decision_delete'
      toolArgs = { decisionId: target }
      break
    case 'wazuh_active_response':
      toolName = 'wazuh_active_response'
      toolArgs = { agent: target, command: (payload?.command as string) ?? '', args: payload?.args }
      break
    case 'firewall_block':
      toolName = 'firewall_block'
      toolArgs = { cidr: target, reason: payload?.reason as string ?? 'Blocked via ORION' }
      break
    case 'investigate':
      toolName = 'elk_flow_search'
      toolArgs = { query: target, limit: (payload?.limit as number) ?? 20 }
      break
    default:
      return { success: false, result: `Unknown action type: ${action.actionType}` }
  }

  const res = await fetch(`${gatewayUrl}/tools/execute`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: toolName, arguments: toolArgs }),
  })

  const result = await res.json()
  if (!res.ok) {
    return { success: false, result: JSON.stringify(result) }
  }

  return { success: true, result: JSON.stringify(result) }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const request = body as ActionRequest

    // Validate required fields
    if (!request.actionType || !request.target || !request.reason) {
      return NextResponse.json({ error: 'Missing required fields: actionType, target, reason' }, { status: 400 })
    }

    // Check panic mode.
    // The seed encodes DISABLED state as defaultTier='auto'. Any other value
    // (operator flips the row in DB or via a future admin route) means panic
    // mode is ENABLED. This avoids the previous bug where the check could
    // never become true because the seed itself shipped with defaultTier='auto'.
    const panicModePolicy = await prisma.actionPolicy.findUnique({
      where: { actionType: '__panic_mode__' },
    })
    const panicMode = !!panicModePolicy && panicModePolicy.defaultTier !== 'auto'

    // Decide tier
    const decision = await decide(request, panicMode)

    // If tier is 'escalate' or 'approve' without approval, return pending
    if (decision.tier === 'escalate' || decision.tier === 'approve') {
      return NextResponse.json({
        pending: true,
        decision,
        message: decision.tier === 'escalate'
          ? 'Action requires escalation'
          : 'Action requires approval',
      })
    }

    // Execute if auto
    const result = await execute(request, decision, gatewayExecutor)

    return NextResponse.json({
      success: result.status !== 'denied',
      status: result.status,
      auditId: result.auditId,
      result: result.result,
    })
  } catch (err) {
    return NextResponse.json({ error: `Action failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 })
  }
}
