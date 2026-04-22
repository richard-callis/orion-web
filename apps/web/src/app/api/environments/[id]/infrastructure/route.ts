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

// Parse text output from `kubectl get pods -o wide`
function parsePodTable(text: string): CachedPod[] {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  // Skip header line, parse each pod row
  // Format: NAMESPACE   NAME   READY   STATUS   RESTARTS   AGE   IP   NODE   NOMINATED NODE   READINESS GATES
  const pods: CachedPod[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(/\s+/)
    if (cols.length < 7) continue

    const namespace = cols[0]
    const name = cols[1]
    const readyMatch = cols[2].match(/(\d+)\/(\d+)/)
    const ready = readyMatch ? parseInt(readyMatch[1]) === parseInt(readyMatch[2]) : false
    const phase = cols[3] as CachedPod['phase']
    const restarts = parseInt(cols[4]) || 0
    const node = cols[7] || ''
    const status = (phase === 'Running' && !ready) ? 'NotReady' :
                   (phase === 'Running') ? 'Running' :
                   phase

    pods.push({
      name,
      namespace,
      node,
      status,
      phase,
      ready,
      restarts,
      age: new Date(), // text output has age string, parse best-effort
      containers: [],
      labels: {},
    })
  }
  return pods
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
    // Fetch nodes and pods independently — large clusters may have too many pods
    // for the gateway's stdout buffer, so a failed pods query should not kill the
    // entire response.
    const [nodesJson, podsText] = await Promise.allSettled([
      gatewayExec(env.gatewayUrl, env.gatewayToken, 'kubectl_get', { resource: 'nodes', output: 'json' }),
      gatewayExec(env.gatewayUrl, env.gatewayToken, 'kubectl_get_pods', {}),
    ])

    // Nodes always required; pods are best-effort
    if (nodesJson.status === 'rejected') {
      const reason = nodesJson.reason instanceof Error ? nodesJson.reason.message : String(nodesJson.reason)
      return NextResponse.json({ error: reason }, { status: 502 })
    }

    const nodeList = JSON.parse(nodesJson.value)
    const nodes: CachedNode[] = (nodeList.items ?? []).map(parseNode).filter((n: CachedNode) => n.name)

    let pods: CachedPod[] = []
    if (podsText.status === 'fulfilled' && podsText.value) {
      try {
        pods = parsePodTable(podsText.value)
      } catch {
        // Pod parsing failed — return nodes with empty pods
      }
    }

    return NextResponse.json({ nodes, pods })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
