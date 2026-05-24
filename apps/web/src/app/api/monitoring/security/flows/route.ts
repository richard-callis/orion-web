import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const query = searchParams.get('q') || '*'
  const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50

  // Gateway credentials live per-environment in the DB, not in env vars.
  // Use the first connected environment that has a gateway configured.
  const env = await prisma.environment.findFirst({
    where: { status: 'connected', gatewayUrl: { not: null } },
    select: { gatewayUrl: true, gatewayToken: true },
  })

  if (!env?.gatewayUrl) {
    return NextResponse.json({ error: 'No connected environment with a gateway configured' }, { status: 503 })
  }

  const res = await fetch(`${env.gatewayUrl}/tools/execute`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.gatewayToken ?? ''}`,
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
