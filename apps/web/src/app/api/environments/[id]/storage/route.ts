import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * GET /api/environments/:id/storage
 * Returns Longhorn volume list for the environment's cluster via gateway.
 */

async function gatewayExec(
  gatewayUrl: string,
  gatewayToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${gatewayUrl}/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
    body: JSON.stringify({ name: toolName, arguments: args }),
  })
  if (!res.ok) throw new Error(`Gateway tool ${toolName} failed: ${res.status}`)
  const data = await res.json() as { result?: string; error?: string }
  if (data.error) throw new Error(data.error)
  return data.result ?? ''
}

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!env.gatewayUrl || !env.gatewayToken) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 422 })
  }

  const { gatewayUrl, gatewayToken } = env

  try {
    // Check if Longhorn namespace exists
    let hasLonghorn = false
    try {
      await gatewayExec(gatewayUrl, gatewayToken, 'kubectl_get', { resource: 'namespace', name: 'longhorn-system' })
      hasLonghorn = true
    } catch {
      hasLonghorn = false
    }

    if (!hasLonghorn) {
      return NextResponse.json({ volumes: [], provider: null })
    }

    const json = await gatewayExec(gatewayUrl, gatewayToken, 'kubectl_get', {
      resource:  'volumes.longhorn.io',
      namespace: 'longhorn-system',
      output:    'json',
    })
    const list = JSON.parse(json) as { items?: unknown[] }
    return NextResponse.json({ volumes: list.items ?? [], provider: 'longhorn' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
