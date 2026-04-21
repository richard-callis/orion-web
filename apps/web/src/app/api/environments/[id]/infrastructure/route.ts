/**
 * GET /api/environments/:id/infrastructure
 *
 * Fetches nodes and pods from an environment via the ORION Gateway.
 * Returns { nodes: CachedNode[], pods: CachedPod[] }
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { CachedNode, CachedPod } from '@/lib/k8s'

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseNode(node: any): CachedNode {
  const labels = node.metadata?.labels ?? {}
  const role = Object.keys(labels)
    .filter((k: string) => k.startsWith('node-role.kubernetes.io/'))
    .map((k: string) => k.replace('node-role.kubernetes.io/', ''))
  if (role.length === 0) role.push('worker')

  const readyCond = node.status?.conditions?.find((c: any) => c.type === 'Ready')

  return {
    name:          node.metadata?.name ?? '',
    ip:            node.status?.addresses?.find((a: any) => a.type === 'InternalIP')?.address ?? '',
    role,
    status:        readyCond?.status === 'True' ? 'Ready' : 'NotReady',
    cpuCapacity:   node.status?.capacity?.['cpu'] ?? '',
    memCapacity:   node.status?.capacity?.['memory'] ?? '',
    kernelVersion: node.status?.nodeInfo?.kernelVersion ?? '',
    osImage:       node.status?.nodeInfo?.osImage ?? '',
    conditions:    node.status?.conditions?.map((c: any) => ({ type: c.type, status: c.status })) ?? [],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parsePod(pod: any): CachedPod {
  const cs = pod.status?.containerStatuses ?? []
  const ready = cs.length > 0 && cs.every((c: any) => c.ready)
  const restarts = cs.reduce((s: number, c: any) => s + (c.restartCount ?? 0), 0)
  const phase = pod.status?.phase ?? 'Unknown'
  let status = phase
  if (!ready && phase === 'Running') status = 'NotReady'
  if (pod.metadata?.deletionTimestamp) status = 'Terminating'

  return {
    name:       pod.metadata?.name ?? '',
    namespace:  pod.metadata?.namespace ?? '',
    node:       pod.spec?.nodeName ?? '',
    status,
    phase,
    ready,
    restarts,
    age:        new Date(pod.metadata?.creationTimestamp ?? 0),
    containers: pod.spec?.containers?.map((c: any) => c.name) ?? [],
    labels:     pod.metadata?.labels ?? {},
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  if (!env.gatewayUrl || !env.gatewayToken) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 422 })
  }

  try {
    const [nodesJson, podsJson] = await Promise.all([
      gatewayExec(env.gatewayUrl, env.gatewayToken, 'kubectl_get', { resource: 'nodes', output: 'json' }),
      gatewayExec(env.gatewayUrl, env.gatewayToken, 'kubectl_get', { resource: 'pods', output: 'json' }),
    ])

    const nodeList = JSON.parse(nodesJson)
    const podList  = JSON.parse(podsJson)

    const nodes: CachedNode[] = (nodeList.items ?? []).map(parseNode).filter((n: CachedNode) => n.name)
    const pods:  CachedPod[]  = (podList.items  ?? []).map(parsePod).filter((p: CachedPod)  => p.name)

    return NextResponse.json({ nodes, pods })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
