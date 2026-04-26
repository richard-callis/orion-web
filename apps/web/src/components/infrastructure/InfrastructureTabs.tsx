'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, ServerCrash, Server, Database, KeyRound, HardDrive, FileText, GitBranch } from 'lucide-react'
import { IngressPage } from '@/components/ingress/IngressPage'
import { GitOpsPage } from '@/components/gitops/GitOpsPage'
import { NodeGrid } from '@/components/infrastructure/NodeGrid'
import { PodTable } from '@/components/infrastructure/PodTable'
import type { CachedNode, CachedPod } from '@/lib/k8s'

type InfraTab = 'overview' | 'ingress' | 'storage' | 'secrets' | 'backups' | 'logs' | 'gitops'

const tabs: { key: InfraTab; label: string; icon: typeof Server }[] = [
  { key: 'overview', label: 'Overview', icon: Server },
  { key: 'ingress', label: 'Ingress', icon: Server },
  { key: 'storage', label: 'Storage', icon: HardDrive },
  { key: 'secrets', label: 'Secrets', icon: KeyRound },
  { key: 'backups', label: 'Backups', icon: FileText },
  { key: 'logs', label: 'Logs', icon: FileText },
  { key: 'gitops', label: 'GitOps', icon: GitBranch },
]

interface Environment {
  id: string
  name: string
  type: string
  status: string
  gatewayUrl: string | null
}

// ── Storage tab ───────────────────────────────────────────────────────────────

interface LonghornVolume {
  metadata: { name: string }
  spec: { numberOfReplicas: number; size: string }
  status: {
    state: string
    robustness: string
    currentNodeID?: string
    kubernetesStatus?: {
      namespace?: string
      pvcName?: string
      pvStatus?: string
      workloadsStatus?: Array<{ podName: string; podStatus: string; workloadName: string; workloadType: string }>
    }
  }
}

function formatBytes(bytes: string | number): string {
  const n = typeof bytes === 'string' ? parseInt(bytes) : bytes
  if (!n) return '—'
  const gb = n / (1024 ** 3)
  return gb >= 1 ? `${gb.toFixed(0)}Gi` : `${(n / (1024 ** 2)).toFixed(0)}Mi`
}

const robustnessColor = (r: string) =>
  r === 'healthy' ? 'text-status-healthy' :
  r === 'degraded' ? 'text-status-warning' :
  r === 'faulted' ? 'text-status-error' : 'text-text-muted'

const stateColor = (s: string) =>
  s === 'attached' ? 'text-status-healthy' :
  s === 'detached' ? 'text-text-muted' : 'text-status-warning'

function StorageTab({ envId, loading, setLoading, error, setError }: {
  envId: string
  loading: boolean
  setLoading: (v: boolean) => void
  error: string | null
  setError: (v: string | null) => void
}) {
  const [volumes, setVolumes] = useState<LonghornVolume[]>([])

  const load = useCallback(async () => {
    if (!envId) return
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/environments/${envId}/storage`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setVolumes(data.volumes ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [envId, setLoading])

  useEffect(() => { load() }, [load])

  const healthy = volumes.filter(v => v.status?.robustness === 'healthy').length
  const degraded = volumes.filter(v => v.status?.robustness === 'degraded').length
  const faulted = volumes.filter(v => v.status?.robustness === 'faulted').length
  const unknown = volumes.length - healthy - degraded - faulted

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Longhorn Volumes</h2>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary border border-border-subtle hover:border-accent/50 disabled:opacity-50 transition-colors">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          <ServerCrash size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Healthy', count: healthy, color: 'text-status-healthy border-status-healthy/30' },
          { label: 'Degraded', count: degraded, color: 'text-status-warning border-status-warning/30' },
          { label: 'Faulted', count: faulted, color: 'text-status-error border-status-error/30' },
          { label: 'Unknown', count: unknown, color: 'text-text-muted border-border-subtle' },
        ].map(({ label, count, color }) => (
          <div key={label} className={`rounded-lg border bg-bg-card p-4 ${color}`}>
            <p className="text-xs text-text-muted">{label} Volumes</p>
            <p className="text-2xl font-mono font-bold mt-1">{count}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border-subtle overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised border-b border-border-subtle">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Claim</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Namespace</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Workload</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Size</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">State</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Robustness</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Replicas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {volumes.map(v => {
              const ks = v.status?.kubernetesStatus
              const workload = ks?.workloadsStatus?.[0]
              return (
                <tr key={v.metadata.name} className="hover:bg-bg-raised">
                  <td className="px-3 py-2 text-xs text-text-primary font-medium max-w-[200px] truncate">
                    {ks?.pvcName ?? <span className="text-text-muted font-mono text-[10px]">{v.metadata.name.slice(0, 16)}…</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-secondary">{ks?.namespace ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-text-secondary max-w-[160px] truncate">
                    {workload ? <span title={workload.podName}>{workload.workloadName}</span> : <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-text-muted">{formatBytes(v.spec?.size)}</td>
                  <td className={`px-3 py-2 text-xs font-medium ${stateColor(v.status?.state)}`}>{v.status?.state}</td>
                  <td className={`px-3 py-2 text-xs font-medium ${robustnessColor(v.status?.robustness)}`}>{v.status?.robustness}</td>
                  <td className="px-3 py-2 text-xs font-mono text-text-muted">{v.spec?.numberOfReplicas ?? '—'}</td>
                </tr>
              )
            })}
            {!volumes.length && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-text-muted text-sm">No Longhorn volumes found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Secrets tab ────────────────────────────────────────────────────────────────

function SecretsTab({ envId, loading, setLoading, error, setError }: {
  envId: string
  loading: boolean
  setLoading: (v: boolean) => void
  error: string | null
  setError: (v: string | null) => void
}) {
  interface ExternalSecret {
    metadata: { name: string; namespace: string }
    status?: { conditions?: Array<{ type: string; status: string; message?: string; lastTransitionTime?: string }> }
  }

  const [secrets, setSecrets] = useState<ExternalSecret[]>([])

  const load = useCallback(async () => {
    if (!envId) return
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/environments/${envId}/secrets`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSecrets(data.externalSecrets ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [envId, setLoading])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">External Secrets (ESO)</h2>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary border border-border-subtle hover:border-accent/50 disabled:opacity-50 transition-colors">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          <ServerCrash size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="rounded-lg border border-border-subtle overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised border-b border-border-subtle">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Name</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Namespace</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Sync Status</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Last Synced</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {secrets.map((es, i) => {
              const ready = es.status?.conditions?.find(c => c.type === 'Ready')
              return (
                <tr key={i} className="hover:bg-bg-raised">
                  <td className="px-3 py-2 font-mono text-xs text-text-primary">{es.metadata.name}</td>
                  <td className="px-3 py-2 text-xs text-text-secondary">{es.metadata.namespace}</td>
                  <td className={`px-3 py-2 text-xs font-medium ${ready?.status === 'True' ? 'text-status-healthy' : 'text-status-error'}`}>
                    {ready?.status === 'True' ? 'Synced' : ready?.message ?? 'Unknown'}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-text-muted">
                    {ready?.lastTransitionTime ? new Date(ready.lastTransitionTime).toLocaleString() : '—'}
                  </td>
                </tr>
              )
            })}
            {!secrets.length && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-text-muted text-sm">No ExternalSecrets found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Backups tab ────────────────────────────────────────────────────────────────

function BackupsTab() {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-6 text-center text-text-muted">
      <p className="text-sm">Backup status coming soon.</p>
      <p className="text-xs mt-2">Will show: TrueNAS last rsync, Longhorn weekly snapshots, PVC coverage.</p>
      <p className="text-xs mt-1">Trigger: <code className="font-mono text-accent">ansible-playbook playbooks/backup/backup-to-truenas.yml</code></p>
    </div>
  )
}

// ── Logs tab ───────────────────────────────────────────────────────────────────

function LogsTab() {
  const [namespace, setNamespace] = useState('apps')
  const [pod, setPod] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [lines])

  const startStream = () => {
    if (!pod) return
    esRef.current?.close()
    setLines([])
    setStreaming(true)
    const es = new EventSource(`/api/k8s/pods/${namespace}/${pod}/logs`)
    esRef.current = es
    es.onmessage = (e) => setLines(prev => [...prev.slice(-500), e.data])
    es.onerror = () => { setStreaming(false); es.close() }
  }

  const stop = () => { esRef.current?.close(); setStreaming(false) }
  useEffect(() => () => esRef.current?.close(), [])

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <input value={namespace} onChange={e => setNamespace(e.target.value)}
          placeholder="namespace" className="px-3 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent w-36 font-mono" />
        <input value={pod} onChange={e => setPod(e.target.value)}
          placeholder="pod name" className="px-3 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent flex-1 font-mono" />
        <button onClick={streaming ? stop : startStream}
          className={`px-3 py-1.5 rounded text-sm font-medium ${streaming ? 'bg-status-error/20 text-status-error' : 'bg-accent text-white hover:bg-accent/80'}`}>
          {streaming ? 'Stop' : 'Stream Logs'}
        </button>
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-card overflow-auto font-mono text-xs p-3 min-h-[300px] max-h-[60vh]">
        {lines.map((line, i) => (
          <div key={i} className="text-text-secondary leading-5 whitespace-pre-wrap">{line}</div>
        ))}
        {!lines.length && (
          <p className="text-text-muted">Enter a namespace and pod name, then click Stream Logs.</p>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function InfrastructureTabs() {
  const [activeTab, setActiveTab] = useState<InfraTab>('overview')
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [envId, setEnvId] = useState('')
  const [nodes, setNodes] = useState<CachedNode[]>([])
  const [pods, setPods] = useState<CachedPod[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  const selectCls = 'text-xs bg-bg-raised border border-border-subtle rounded-lg px-2 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent'

  // Load environments
  useEffect(() => {
    console.log('[InfrastructureTabs] Mounting, fetching environments...')
    fetch('/api/environments')
      .then(r => {
        console.log('[InfrastructureTabs] API response status:', r.status, 'ok:', r.ok)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((envs: Environment[]) => {
        console.log('[InfrastructureTabs] Loaded', envs.length, 'environments:', envs.map(e => ({ name: e.name, type: e.type })))
        if (!Array.isArray(envs)) return
        const clusters = envs.filter(e => e.type === 'cluster' && e.gatewayUrl)
        console.log('[InfrastructureTabs] Filtered to', clusters.length, 'clusters:', clusters.map(e => e.name))
        setEnvironments(clusters)
        if (clusters.length === 1) setEnvId(clusters[0].id)
        else if (clusters.length === 0) {
          console.warn('[InfrastructureTabs] No cluster environments found')
        }
      })
      .catch((err) => {
        console.error('[InfrastructureTabs] Failed to load environments:', err)
      })
  }, [])

  const fetchInfrastructure = useCallback(async (id: string) => {
    if (!id) return
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/environments/${id}/infrastructure`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; detail?: string }
        const errMsg = body.error ?? `HTTP ${res.status}`
        const fullMsg = body.detail ? `${errMsg}\n\n${body.detail}` : errMsg
        throw new Error(fullMsg)
      }
      const data = await res.json() as { nodes: CachedNode[]; pods: CachedPod[] }
      setNodes(data.nodes)
      setPods(data.pods.map(p => ({ ...p, age: new Date(p.age) })))
      setSelectedNode(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (envId) fetchInfrastructure(envId)
    else { setNodes([]); setPods([]) }
  }, [envId, fetchInfrastructure])

  // Tab bar styling
  const tabCls = (t: InfraTab) =>
    `px-3 py-1.5 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
      activeTab === t
        ? 'bg-accent/10 text-accent border border-accent/30'
        : 'text-text-muted hover:text-text-primary hover:bg-bg-raised'
    }`

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex gap-1 flex-wrap border-b border-border-subtle pb-2">
        {tabs.map(t => (
          <button key={t.key} className={tabCls(t.key)} onClick={() => { setActiveTab(t.key); setLoading(false); setError(null) }}>
            <t.icon size={11} className="inline mr-1" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Toolbar — only show on overview tab */}
      {activeTab === 'overview' && (
        <>
          <div className="flex items-center gap-2">
            <select
              value={envId}
              onChange={e => {
                setEnvId(e.target.value)
                console.log('[InfrastructureTabs] Selected env:', e.target.value, 'Options:', environments.map(e => e.name))
              }}
              className={selectCls}
              disabled={loading || environments.length === 0}
            >
              <option value="">Select environment…</option>
              {environments.map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            {environments.length === 0 && !loading && (
              <span className="text-xs text-text-muted">No cluster environments found</span>
            )}

            {envId && (
              <button
                onClick={() => fetchInfrastructure(envId)}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary border border-border-subtle hover:border-accent/50 disabled:opacity-50 transition-colors"
              >
                <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>
            )}

            {loading && (
              <span className="text-xs text-text-muted">Loading…</span>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
              <ServerCrash size={14} className="mt-0.5 flex-shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}

          {environments.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-8 text-text-muted">
              <ServerCrash size={24} className="mb-2 opacity-30" />
              <p className="text-xs">No cluster environments found</p>
              <p className="text-[10px] mt-1">Check that environments have type="cluster" and a gatewayUrl configured</p>
            </div>
          )}

          {!envId && !loading && environments.length > 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-text-muted">
              <ServerCrash size={24} className="mb-2 opacity-30" />
              <p className="text-xs">Select a cluster environment to view infrastructure</p>
            </div>
          )}
        </>
      )}

      {/* Tab content */}
      <div className="p-4 lg:p-6 space-y-5">
        {activeTab === 'overview' && (
          <>
            {nodes.length > 0 && (
              <>
                <NodeGrid
                  nodes={nodes}
                  metrics={[]}
                  selectedNode={selectedNode}
                  onNodeClick={name => setSelectedNode(prev => prev === name ? null : name)}
                />
                <PodTable pods={pods} nodeFilter={selectedNode} />
              </>
            )}
            {!envId && !loading && (
              <div className="flex flex-col items-center justify-center py-16 text-text-muted">
                <ServerCrash size={32} className="mb-3 opacity-30" />
                <p className="text-sm">Select a cluster environment to view infrastructure</p>
              </div>
            )}
          </>
        )}

        {activeTab === 'ingress' && <IngressPage />}

        {activeTab === 'storage' && (
          <StorageTab
            envId={envId}
            loading={loading}
            setLoading={setLoading}
            error={error}
            setError={setError}
          />
        )}

        {activeTab === 'secrets' && (
          <SecretsTab
            envId={envId}
            loading={loading}
            setLoading={setLoading}
            error={error}
            setError={setError}
          />
        )}

        {activeTab === 'backups' && <BackupsTab />}

        {activeTab === 'logs' && <LogsTab />}

        {activeTab === 'gitops' && <GitOpsPage />}
      </div>
    </div>
  )
}
