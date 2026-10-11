/**
 * GET /api/environments/:id/infrastructure
 *
 * Fetches nodes and pods from an environment via the ORION Gateway.
 * Returns { nodes: CachedNode[], pods: CachedPod[], metrics: NodeMetric[], metricsError?: string }
 * (metrics is empty, with metricsError saying why, when node usage can't be read).
 */
import { gatewayHeaders } from '@/lib/gateway-headers'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import type { CachedNode, CachedPod, NodeMetric } from '@/lib/k8s'

async function gatewayExec(
  gatewayUrl: string,
  gatewayToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${gatewayUrl}/tools/execute`, {
    method: 'POST',
    headers: gatewayHeaders(gatewayToken),
    body: JSON.stringify({ name: toolName, arguments: args }),
  })
  // The gateway puts kubectl's error text in the body of non-2xx responses
  const data = await res.json().catch(() => ({})) as { result?: string; error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `Gateway tool ${toolName} failed: ${res.status}`)
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

const QUANTITY_SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
}

// Parse a Kubernetes resource quantity ("250m", "1234567n", "2Gi") to base units.
function parseQuantity(q: string): number {
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(q ?? '')
  const mult = m ? QUANTITY_SUFFIX[m[2]] : undefined
  return m && mult !== undefined ? parseFloat(m[1]) * mult : NaN
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseNodeMetric(item: any): NodeMetric {
  return {
    name:         item.metadata?.name ?? '',
    cpuUsageNano: Math.round(parseQuantity(item.usage?.cpu) * 1e9),
    memUsageKi:   Math.round(parseQuantity(item.usage?.memory) / 1024),
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
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const env = await prisma.environment.findUnique({ where: { id: (await params).id } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  if (!env.gatewayUrl || !env.gatewayToken) {
    const missing = []
    if (!env.gatewayUrl) missing.push('gatewayUrl')
    if (!env.gatewayToken) missing.push('gatewayToken')
    return NextResponse.json({
      error: `Gateway not connected (missing: ${missing.join(', ')})`,
      detail: 'The gateway pod may still be joining. Check the gateway pod logs: kubectl logs -n management -l app=orion-gateway-<env-name> -f',
    }, { status: 422 })
  }

  try {
    // Fetch nodes and pods independently — large clusters may have too many pods
    // for the gateway's stdout buffer, so a failed pods query should not kill the
    // entire response.
    const [nodesJson, podsText, metricsJson] = await Promise.allSettled([
      gatewayExec(env.gatewayUrl, env.gatewayToken, 'kubectl_get', { resource: 'nodes', output: 'json' }),
      gatewayExec(env.gatewayUrl, env.gatewayToken, 'kubectl_get_pods', {}),
      gatewayExec(env.gatewayUrl, env.gatewayToken, 'kubectl_get', { resource: 'nodes.metrics.k8s.io', output: 'json' }),
    ])

    // Nodes always required; pods and metrics are best-effort
    if (nodesJson.status === 'rejected') {
      const reason = nodesJson.reason instanceof Error ? nodesJson.reason.message : String(nodesJson.reason)
      return NextResponse.json({ error: reason }, { status: 502 })
    }
    const nodesJsonResult = nodesJson.status === 'fulfilled' ? nodesJson.value : null
    if (!nodesJsonResult) {
      return NextResponse.json({ error: 'nodes query returned no data' }, { status: 502 })
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

    // Needs metrics-server in the cluster and metrics.k8s.io read access for the gateway
    let metrics: NodeMetric[] = []
    let metricsError: string | undefined
    if (metricsJson.status === 'rejected') {
      metricsError = metricsJson.reason instanceof Error ? metricsJson.reason.message : String(metricsJson.reason)
    } else {
      try {
        metrics = (JSON.parse(metricsJson.value).items ?? []).map(parseNodeMetric)
          .filter((m: NodeMetric) => m.name && Number.isFinite(m.cpuUsageNano) && Number.isFinite(m.memUsageKi))
        if (metrics.length === 0) metricsError = 'metrics-server returned no node metrics'
      } catch {
        // Non-JSON output is kubectl's error text (e.g. Forbidden, or no metrics-server)
        metricsError = metricsJson.value.trim() || 'empty response from gateway'
      }
    }
    if (metricsError) metricsError = metricsError.slice(0, 500)

    return NextResponse.json({ nodes, pods, metrics, metricsError })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
