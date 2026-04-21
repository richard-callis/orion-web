/**
 * GET /api/environments/:id/storage-stats
 *
 * Detects Longhorn or Rook-Ceph and returns capacity stats via the Gateway.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export interface StorageNode {
  name:       string
  totalBytes: number
  usedBytes:  number
  freeBytes:  number
}

export interface StorageStats {
  provider:   'longhorn' | 'ceph' | null
  totalBytes: number
  usedBytes:  number
  freeBytes:  number
  nodes:      StorageNode[]
}

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

async function namespaceExists(gatewayUrl: string, gatewayToken: string, ns: string): Promise<boolean> {
  try {
    await gatewayExec(gatewayUrl, gatewayToken, 'kubectl_get', { resource: 'namespace', name: ns })
    return true
  } catch {
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function longhornStats(items: any[]): StorageStats {
  const nodes: StorageNode[] = []

  for (const node of items) {
    const diskStatus = node.status?.diskStatus ?? {}
    let total = 0, free = 0

    for (const disk of Object.values(diskStatus) as any[]) {
      total += disk.storageMaximum   ?? 0
      free  += disk.storageAvailable ?? 0
    }

    if (total > 0) {
      nodes.push({
        name:       node.metadata?.name ?? 'unknown',
        totalBytes: total,
        usedBytes:  total - free,
        freeBytes:  free,
      })
    }
  }

  const totalBytes = nodes.reduce((s, n) => s + n.totalBytes, 0)
  const freeBytes  = nodes.reduce((s, n) => s + n.freeBytes,  0)
  return { provider: 'longhorn', totalBytes, usedBytes: totalBytes - freeBytes, freeBytes, nodes }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cephStats(cluster: any): StorageStats {
  const cap = cluster.status?.ceph?.capacity ?? {}
  const totalBytes = cap.bytesTotal     ?? 0
  const usedBytes  = cap.bytesUsed      ?? 0
  const freeBytes  = cap.bytesAvailable ?? 0
  return { provider: 'ceph', totalBytes, usedBytes, freeBytes, nodes: [] }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env)                          return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  if (!env.gatewayUrl || !env.gatewayToken) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 422 })
  }

  const { gatewayUrl, gatewayToken } = env

  try {
    // Detect provider
    const [hasLonghorn, hasCeph] = await Promise.all([
      namespaceExists(gatewayUrl, gatewayToken, 'longhorn-system'),
      namespaceExists(gatewayUrl, gatewayToken, 'rook-ceph'),
    ])

    if (hasLonghorn) {
      const json = await gatewayExec(gatewayUrl, gatewayToken, 'kubectl_get', {
        resource:  'nodes.longhorn.io',
        namespace: 'longhorn-system',
        output:    'json',
      })
      const list = JSON.parse(json)
      return NextResponse.json(longhornStats(list.items ?? []))
    }

    if (hasCeph) {
      const json = await gatewayExec(gatewayUrl, gatewayToken, 'kubectl_get', {
        resource:  'cephcluster',
        name:      'rook-ceph',
        namespace: 'rook-ceph',
        output:    'json',
      })
      return NextResponse.json(cephStats(JSON.parse(json)))
    }

    // No storage provider found
    const stats: StorageStats = { provider: null, totalBytes: 0, usedBytes: 0, freeBytes: 0, nodes: [] }
    return NextResponse.json(stats)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
