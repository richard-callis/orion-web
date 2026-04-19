/**
 * POST /api/environments/:id/gateway/update
 *
 * Tells the gateway to update itself to the latest image.
 * - cluster gateways: kubectl rollout restart deployment/orion-gateway -n orion-management
 * - localhost/docker gateways: docker pull + docker restart via the gateway's /update endpoint
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  if (!env.gatewayUrl || !env.gatewayToken) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 422 })
  }

  const res = await fetch(`${env.gatewayUrl}/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.gatewayToken}` },
  })

  if (!res.ok) {
    const body = await res.text()
    return NextResponse.json({ error: `Gateway update failed: ${res.status} ${body}` }, { status: 502 })
  }

  return NextResponse.json({ ok: true, message: 'Gateway update triggered' })
}
