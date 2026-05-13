import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q') || '*'
  const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50
  const index = searchParams.get('index') || 'netflow-*'

  // Get Gateway URL from environment
  const gatewayUrl = process.env.GATEWAY_URL
  if (!gatewayUrl) {
    return NextResponse.json({ error: 'Gateway URL not configured' }, { status: 503 })
  }

  const gatewayToken = process.env.GATEWAY_TOKEN
  if (!gatewayToken) {
    return NextResponse.json({ error: 'Gateway token not configured' }, { status: 503 })
  }

  // Call Gateway's elk_flow_search tool via REST API
  const res = await fetch(`${gatewayUrl}/tools/execute`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${gatewayToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'elk_flow_search',
      arguments: { query, limit },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    return NextResponse.json({ error: text }, { status: res.status })
  }

  const data = await res.json()
  return NextResponse.json({ flows: data })
}
