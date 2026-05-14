import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { action, ...params } = body as { action: string; [key: string]: unknown }

  const gatewayUrl = process.env.GATEWAY_URL
  const gatewayToken = process.env.GATEWAY_TOKEN

  if (!gatewayUrl || !gatewayToken) {
    return NextResponse.json({ error: 'Gateway not configured' }, { status: 503 })
  }

  let toolName = ''
  let toolArgs: Record<string, unknown> = {}

  switch (action) {
    case 'block_ip':
      toolName = 'crowdsec_block_ip'
      toolArgs = { ip: params.ip, reason: params.reason || 'Blocked via ORION' }
      break
    case 'quarantine_device':
      // Route to CrowdSec for IP block
      toolName = 'crowdsec_block_ip'
      toolArgs = { ip: params.ip, reason: params.deviceId ? `Quarantine: ${params.deviceId}` : 'Quarantine' }
      break
    case 'investigate':
      toolName = 'elk_flow_search'
      toolArgs = { query: params.ip ? `src_ip:${params.ip}` : '*', limit: 20 }
      break
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
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
    return NextResponse.json({ error: result.error || result }, { status: res.status })
  }

  return NextResponse.json({ success: true, result })
}
