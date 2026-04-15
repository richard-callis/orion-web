import * as k8s from '@kubernetes/client-node'
import https from 'https'
import fs from 'fs'

// ── Singleton K8s client ──────────────────────────────────────────────────────

const kc = new k8s.KubeConfig()
// loadFromDefault tries in order: KUBECONFIG env → ~/.kube/config → in-cluster service account
// This works for both Docker (kubeconfig mounted at /root/.kube) and in-cluster deployments
try {
  kc.loadFromDefault()
} catch {
  // No kubeconfig available — k8s features will be unavailable
  console.warn('[k8s] No kubeconfig found — Kubernetes features disabled')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const coreApi: any   = kc.makeApiClient(k8s.CoreV1Api)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const appsApi: any   = kc.makeApiClient(k8s.AppsV1Api)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const networkApi: any = kc.makeApiClient(k8s.NetworkingV1Api)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const customApi: any = kc.makeApiClient(k8s.CustomObjectsApi)
export const kubeConfig = kc

// ── In-memory cluster state cache ────────────────────────────────────────────

export interface CachedPod {
  name: string
  namespace: string
  node: string
  status: string
  phase: string
  ready: boolean
  restarts: number
  age: Date
  containers: string[]
  labels: Record<string, string>
}

export interface CachedNode {
  name: string
  ip: string
  role: string[]
  status: string
  cpuCapacity: string
  memCapacity: string
  kernelVersion: string
  osImage: string
  conditions: Array<{ type: string; status: string }>
}

export interface ClusterCache {
  pods: CachedPod[]
  nodes: CachedNode[]
  lastUpdated: Date
}

let cache: ClusterCache = {
  pods: [],
  nodes: [],
  lastUpdated: new Date(0),
}

export function getCache(): ClusterCache {
  return cache
}

// ── SSE fan-out ────────────────────────────────────────────────────────────────

type SseClient = { write: (data: string) => void; close: () => void }
const sseClients = new Set<SseClient>()

export function addSseClient(client: SseClient) {
  sseClients.add(client)
}

export function removeSseClient(client: SseClient) {
  sseClients.delete(client)
}

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try { client.write(msg) } catch { sseClients.delete(client) }
  }
}

// ── Pod parser ────────────────────────────────────────────────────────────────

function parsePod(pod: k8s.V1Pod): CachedPod {
  const cs = pod.status?.containerStatuses ?? []
  const ready = cs.every(c => c.ready)
  const restarts = cs.reduce((s, c) => s + (c.restartCount ?? 0), 0)
  const phase = pod.status?.phase ?? 'Unknown'
  let status = phase
  if (!ready && phase === 'Running') status = 'NotReady'
  if (pod.metadata?.deletionTimestamp) status = 'Terminating'

  return {
    name: pod.metadata?.name ?? '',
    namespace: pod.metadata?.namespace ?? '',
    node: pod.spec?.nodeName ?? '',
    status,
    phase,
    ready,
    restarts,
    age: new Date(pod.metadata?.creationTimestamp ?? 0),
    containers: pod.spec?.containers?.map(c => c.name) ?? [],
    labels: pod.metadata?.labels ?? {},
  }
}

function parseNode(node: k8s.V1Node): CachedNode {
  const labels = node.metadata?.labels ?? {}
  const role = Object.keys(labels)
    .filter(k => k.startsWith('node-role.kubernetes.io/'))
    .map(k => k.replace('node-role.kubernetes.io/', ''))
  if (role.length === 0) role.push('worker')

  const readyCond = node.status?.conditions?.find(c => c.type === 'Ready')
  const status = readyCond?.status === 'True' ? 'Ready' : 'NotReady'

  return {
    name: node.metadata?.name ?? '',
    ip: node.status?.addresses?.find(a => a.type === 'InternalIP')?.address ?? '',
    role,
    status,
    cpuCapacity: node.status?.capacity?.['cpu'] ?? '',
    memCapacity: node.status?.capacity?.['memory'] ?? '',
    kernelVersion: node.status?.nodeInfo?.kernelVersion ?? '',
    osImage: node.status?.nodeInfo?.osImage ?? '',
    conditions: node.status?.conditions?.map(c => ({ type: c.type, status: c.status })) ?? [],
  }
}

// ── Watcher bootstrap ─────────────────────────────────────────────────────────

let watchersStarted = false

export async function startWatchers() {
  if (watchersStarted) return
  watchersStarted = true

  // Initial list-then-watch
  await refreshCache()

  const watch = new k8s.Watch(kc)

  // Pod watcher
  watchResource(watch, '/api/v1/pods', (type, obj) => {
    try {
      const pod = parsePod(obj as k8s.V1Pod)
      if (!pod.name) return  // skip phantom/bookmark events with no metadata
      if (type === 'DELETED') {
        cache.pods = cache.pods.filter(p => !(p.name === pod.name && p.namespace === pod.namespace))
      } else {
        const idx = cache.pods.findIndex(p => p.name === pod.name && p.namespace === pod.namespace)
        if (idx >= 0) cache.pods[idx] = pod
        else cache.pods.push(pod)
      }
      broadcast('pod', { type, pod })
    } catch (err) {
      console.error('Pod watch handler error:', err)
    }
  })

  // Node watcher
  watchResource(watch, '/api/v1/nodes', (type, obj) => {
    try {
      const node = parseNode(obj as k8s.V1Node)
      if (!node.name) return  // skip phantom/bookmark events with no metadata
      if (type === 'DELETED') {
        cache.nodes = cache.nodes.filter(n => n.name !== node.name)
      } else {
        const idx = cache.nodes.findIndex(n => n.name === node.name)
        if (idx >= 0) cache.nodes[idx] = node
        else cache.nodes.push(node)
      }
      broadcast('node', { type, node })
    } catch (err) {
      console.error('Node watch handler error:', err)
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function watchResource(watch: k8s.Watch, path: string, handler: (type: string, obj: any) => void) {
  let failCount = 0
  const start = () => {
    watch.watch(path, { allowWatchBookmarks: true }, handler, (err) => {
      if (err && failCount === 0) console.warn(`[k8s] Watch ended ${path}: ${(err as Error).message ?? err}`)
      setTimeout(start, 30_000)
    }).catch((err) => {
      if (failCount === 0) console.warn(`[k8s] Watch unavailable ${path}: ${(err as Error).message ?? err}`)
      failCount++
      setTimeout(start, 30_000)
    })
  }
  start()
}

// ── Node metrics (actual CPU/memory usage from metrics-server) ─────────────

export interface NodeMetric {
  name: string
  cpuUsageNano: number   // nanocores
  memUsageKi: number     // kibibytes
}

export async function fetchNodeMetrics(): Promise<NodeMetric[]> {
  try {
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8')
    const ca    = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt')
    const host  = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc'
    const port  = process.env.KUBERNETES_SERVICE_PORT ?? '443'

    const body = await new Promise<string>((resolve, reject) => {
      const req = https.get({
        hostname: host, port: Number(port),
        path: '/apis/metrics.k8s.io/v1beta1/nodes',
        headers: { Authorization: `Bearer ${token}` },
        ca,
      }, res => {
        let data = ''
        res.on('data', (c: string) => { data += c })
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = JSON.parse(body)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (parsed.items ?? []).map((item: any) => ({
      name: item.metadata.name,
      cpuUsageNano: parseInt(item.usage.cpu.replace('n', ''), 10),
      memUsageKi:   parseInt(item.usage.memory.replace('Ki', ''), 10),
    }))
  } catch {
    return []
  }
}

export async function refreshCache() {
  try {
    const [podRes, nodeRes] = await Promise.all([
      coreApi.listPodForAllNamespaces(),
      coreApi.listNode(),
    ])
    cache.pods = ((podRes.body?.items ?? podRes.items ?? []) as k8s.V1Pod[]).map(parsePod).filter(p => p.name)
    cache.nodes = ((nodeRes.body?.items ?? nodeRes.items ?? []) as k8s.V1Node[]).map(parseNode).filter(n => n.name)
    cache.lastUpdated = new Date()
  } catch (err) {
    console.error('Cache refresh error:', err)
  }
}
