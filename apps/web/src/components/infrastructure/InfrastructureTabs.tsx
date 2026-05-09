'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, ServerCrash, Server, Database, KeyRound, HardDrive, FileText, GitBranch, Plus, X, Trash2, ChevronDown, ChevronUp, Pencil } from 'lucide-react'
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

interface ManagedSecret {
  id: string
  name: string
  namespace: string
  description: string | null
  secretStore: string
  secretStoreKind: string
  remoteRef: string
  targetSecretName: string | null
  refreshInterval: string
  dataKeys: Array<{ secretKey: string; remoteKey: string }>
  tags: string[]
  status: string
  statusMessage: string | null
  appliedAt: string | null
  createdAt: string
  creator?: { id: string; username: string; name: string | null } | null
}

const BLANK_FORM = {
  name: '',
  namespace: 'default',
  description: '',
  secretStore: 'vault-backend',
  secretStoreKind: 'ClusterSecretStore' as 'ClusterSecretStore' | 'SecretStore',
  remoteRef: '',
  targetSecretName: '',
  refreshInterval: '1h',
  tags: '',
}

const STATUS_COLORS: Record<string, string> = {
  draft:   'text-text-muted border-border-subtle',
  applied: 'text-status-healthy border-status-healthy/30 bg-status-healthy/10',
  error:   'text-status-error border-status-error/30 bg-status-error/10',
}

function SecretsTab({ envId, loading, setLoading, error, setError }: {
  envId: string
  loading: boolean
  setLoading: (v: boolean) => void
  error: string | null
  setError: (v: string | null) => void
}) {
  const [secrets, setSecrets] = useState<ManagedSecret[]>([])
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [form, setForm] = useState(BLANK_FORM)
  // Each row = one secret key/value pair written directly to Vault
  const [secretValues, setSecretValues] = useState<Array<{ vaultKey: string; value: string; k8sKey: string }>>([
    { vaultKey: '', value: '', k8sKey: '' },
  ])
  // Edit modal state — update values on an existing secret
  const [editSecret, setEditSecret] = useState<ManagedSecret | null>(null)
  const [editValues, setEditValues] = useState<Array<{ vaultKey: string; value: string; k8sKey: string }>>([])
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!envId) return
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/environments/${envId}/secrets`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { secrets: ManagedSecret[] }
      setSecrets(data.secrets ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [envId, setLoading, setError])

  useEffect(() => { load() }, [load])

  const openModal = () => {
    setForm(BLANK_FORM)
    setSecretValues([{ vaultKey: '', value: '', k8sKey: '' }])
    setModalError(null)
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim())      { setModalError('Secret name is required'); return }
    if (!form.remoteRef.trim()) { setModalError('Vault path is required'); return }

    const validRows = secretValues.filter(r => r.vaultKey.trim())
    if (validRows.length === 0) { setModalError('At least one secret key is required'); return }

    setSaving(true); setModalError(null)
    try {
      const res = await fetch(`/api/environments/${envId}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:             form.name.trim(),
          namespace:        form.namespace.trim() || 'default',
          description:      form.description.trim() || null,
          secretStore:      form.secretStore.trim() || 'vault-backend',
          secretStoreKind:  form.secretStoreKind,
          remoteRef:        form.remoteRef.trim(),
          targetSecretName: form.targetSecretName.trim() || null,
          refreshInterval:  form.refreshInterval.trim() || '1h',
          secretValues:     validRows,   // written to Vault — never stored in DB
          tags:             form.tags.split(',').map(t => t.trim()).filter(Boolean),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setModalError((data as { error?: string }).error ?? `HTTP ${res.status}`); return }
      setShowModal(false)
      await load()
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    setDeleting(id)
    try {
      await fetch(`/api/environments/${envId}/secrets/${id}`, { method: 'DELETE' })
      setSecrets(prev => prev.filter(s => s.id !== id))
      if (expandedId === id) setExpandedId(null)
    } finally {
      setDeleting(null)
    }
  }

  const openEditModal = (s: ManagedSecret) => {
    // Pre-populate key names from dataKeys; values start blank (never stored)
    setEditValues(
      s.dataKeys.length > 0
        ? s.dataKeys.map(k => ({ vaultKey: k.remoteKey, value: '', k8sKey: k.secretKey }))
        : [{ vaultKey: '', value: '', k8sKey: '' }]
    )
    setEditError(null)
    setEditSecret(s)
  }

  const handleEditSave = async () => {
    if (!editSecret) return
    const validRows = editValues.filter(r => r.vaultKey.trim() && r.value.trim())
    if (validRows.length === 0) { setEditError('Enter at least one key and value'); return }

    setEditSaving(true); setEditError(null)
    try {
      const res = await fetch(`/api/environments/${envId}/secrets/${editSecret.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretValues: validRows }),
      })
      const data = await res.json()
      if (!res.ok) { setEditError((data as { error?: string }).error ?? `HTTP ${res.status}`); return }
      setEditSecret(null)
      await load()
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditSaving(false)
    }
  }

  const addValueRow    = () => setSecretValues(prev => [...prev, { vaultKey: '', value: '', k8sKey: '' }])
  const removeValueRow = (i: number) => setSecretValues(prev => prev.filter((_, idx) => idx !== i))
  const updateValueRow = (i: number, f: 'vaultKey' | 'value' | 'k8sKey', val: string) =>
    setSecretValues(prev => prev.map((r, idx) => idx === i ? { ...r, [f]: val } : r))

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-text-secondary">{label}</label>
      {node}
      {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
    </div>
  )

  const inputCls = 'w-full px-2.5 py-1.5 rounded border border-border-visible bg-bg-raised text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent'
  const selectCls = inputCls

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">External Secrets (ESO + Vault)</h2>
          <p className="text-[10px] text-text-muted mt-0.5">ExternalSecret CRDs synced from Vault via the External Secrets Operator</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary border border-border-subtle hover:border-accent/50 disabled:opacity-50 transition-colors">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button onClick={openModal} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-accent border border-accent/40 hover:bg-accent/10 transition-colors">
            <Plus size={11} />
            Add Secret
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          <ServerCrash size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Secret list */}
      <div className="rounded-lg border border-border-subtle overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised border-b border-border-subtle">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Name</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Namespace</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Vault Path</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Refresh</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {secrets.map(s => (
              <>
                <tr
                  key={s.id}
                  className="hover:bg-bg-raised cursor-pointer"
                  onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                >
                  <td className="px-3 py-2 font-mono text-xs text-text-primary">{s.name}</td>
                  <td className="px-3 py-2 text-xs text-text-secondary">{s.namespace}</td>
                  <td className="px-3 py-2 font-mono text-xs text-text-muted truncate max-w-[180px]">{s.remoteRef}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">{s.refreshInterval}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${STATUS_COLORS[s.status] ?? STATUS_COLORS.draft}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {expandedId === s.id ? <ChevronUp size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
                      <button
                        onClick={e => { e.stopPropagation(); openEditModal(s) }}
                        className="p-1 rounded text-text-muted hover:text-accent transition-colors"
                        title="Update secret values in Vault"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(s.id) }}
                        disabled={deleting === s.id}
                        className="p-1 rounded text-text-muted hover:text-status-error transition-colors disabled:opacity-40"
                        title="Delete secret"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
                {expandedId === s.id && (
                  <tr key={`${s.id}-detail`} className="bg-bg-raised/50">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
                        <div><span className="text-text-muted">Secret Store:</span> <span className="font-mono text-text-primary">{s.secretStore}</span> <span className="text-text-muted">({s.secretStoreKind})</span></div>
                        <div><span className="text-text-muted">Target K8s secret:</span> <span className="font-mono text-text-primary">{s.targetSecretName || s.name}</span></div>
                        {s.description && (
                          <div className="col-span-2"><span className="text-text-muted">Description:</span> <span className="text-text-secondary">{s.description}</span></div>
                        )}
                        {s.dataKeys.length > 0 && (
                          <div className="col-span-2">
                            <span className="text-text-muted">Key mappings:</span>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {s.dataKeys.map((k, i) => (
                                <span key={i} className="font-mono text-[10px] bg-bg-sidebar border border-border-subtle px-1.5 py-0.5 rounded">
                                  {k.remoteKey} → {k.secretKey}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {s.tags.length > 0 && (
                          <div className="col-span-2">
                            <span className="text-text-muted">Tags:</span>
                            <span className="ml-1 text-text-secondary">{s.tags.join(', ')}</span>
                          </div>
                        )}
                        <div className="col-span-2 pt-1 text-[10px] text-text-muted">
                          Created {new Date(s.createdAt).toLocaleString()}{s.creator ? ` by ${s.creator.name || s.creator.username}` : ''}
                          {s.appliedAt ? ` · Applied ${new Date(s.appliedAt).toLocaleString()}` : ' · Not yet applied'}
                        </div>
                        {s.statusMessage && (
                          <div className="col-span-2 text-[10px] text-status-error">{s.statusMessage}</div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
            {!secrets.length && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-text-muted text-sm">
                  No secrets defined yet.{' '}
                  <button onClick={openModal} className="text-accent hover:underline">Add the first one.</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Edit Secret Values Modal */}
      {editSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setEditSecret(null)}>
          <div
            className="w-full max-w-lg bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
              <div className="flex items-center gap-2">
                <Pencil size={14} className="text-accent" />
                <span className="text-sm font-semibold text-text-primary">Update Secret Values</span>
                <span className="font-mono text-xs text-text-muted">· {editSecret.name}</span>
              </div>
              <button onClick={() => setEditSecret(null)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2.5 text-[10px] text-text-muted leading-relaxed">
                Values are written <span className="text-accent font-semibold">directly to Vault</span> at <span className="font-mono text-text-secondary">{editSecret.remoteRef}</span> and are never stored in ORION.
                Current values are in Vault — enter new values to overwrite them.
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Secret Values</p>
                  <button
                    onClick={() => setEditValues(prev => [...prev, { vaultKey: '', value: '', k8sKey: '' }])}
                    className="inline-flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 transition-colors"
                  >
                    <Plus size={10} /> Add key
                  </button>
                </div>
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-[10px] text-text-muted px-0.5">
                    <span>Vault key</span>
                    <span>New value <span className="text-accent">*</span></span>
                    <span>K8s key (optional)</span>
                    <span />
                  </div>
                  {editValues.map((row, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                      <input
                        className="w-full px-2.5 py-1.5 rounded border border-border-visible bg-bg-raised text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                        placeholder="password"
                        value={row.vaultKey}
                        onChange={e => setEditValues(prev => prev.map((r, idx) => idx === i ? { ...r, vaultKey: e.target.value } : r))}
                      />
                      <input
                        className="w-full px-2.5 py-1.5 rounded border border-border-visible bg-bg-raised text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                        type="password"
                        placeholder="new value"
                        value={row.value}
                        onChange={e => setEditValues(prev => prev.map((r, idx) => idx === i ? { ...r, value: e.target.value } : r))}
                        autoComplete="new-password"
                      />
                      <input
                        className="w-full px-2.5 py-1.5 rounded border border-border-visible bg-bg-raised text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                        placeholder={row.vaultKey || 'DB_PASSWORD'}
                        value={row.k8sKey}
                        onChange={e => setEditValues(prev => prev.map((r, idx) => idx === i ? { ...r, k8sKey: e.target.value } : r))}
                      />
                      <button
                        onClick={() => setEditValues(prev => prev.filter((_, idx) => idx !== i))}
                        disabled={editValues.length === 1}
                        className="p-1 rounded text-text-muted hover:text-status-error transition-colors disabled:opacity-30"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {editError && (
              <div className="px-5 py-2 border-t border-status-error/30 bg-status-error/10 text-xs text-status-error flex items-center gap-2 flex-shrink-0">
                <ServerCrash size={12} />
                <span>{editError}</span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle flex-shrink-0">
              <button onClick={() => setEditSecret(null)} className="px-3 py-1.5 rounded text-xs border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button onClick={handleEditSave} disabled={editSaving} className="px-4 py-1.5 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30 disabled:opacity-50 flex items-center gap-1.5 transition-colors">
                {editSaving ? <RefreshCw size={11} className="animate-spin" /> : <KeyRound size={11} />}
                {editSaving ? 'Writing to Vault…' : 'Write to Vault'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Secret Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowModal(false)}>
          <div
            className="w-full max-w-xl bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
              <div className="flex items-center gap-2">
                <KeyRound size={14} className="text-accent" />
                <span className="text-sm font-semibold text-text-primary">Add External Secret</span>
              </div>
              <button onClick={() => setShowModal(false)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

              {/* Info banner */}
              <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2.5 text-[10px] text-text-muted leading-relaxed">
                Secret values are written <span className="text-accent font-semibold">directly to Vault</span> and are never stored in ORION.
                Only the path and key names are saved here. ESO then syncs the values into the cluster as a Kubernetes Secret automatically.
              </div>

              {/* Identity */}
              <div className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Identity</p>
                <div className="grid grid-cols-2 gap-3">
                  {field('Secret Name *',
                    <input className={inputCls} placeholder="my-app-db-secret" value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />,
                    'ExternalSecret CRD name. Also becomes the K8s Secret name unless overridden below.'
                  )}
                  {field('Namespace *',
                    <input className={inputCls} placeholder="default" value={form.namespace}
                      onChange={e => setForm(f => ({ ...f, namespace: e.target.value }))} />,
                    'Kubernetes namespace where the Secret will be created.'
                  )}
                </div>
                {field('Description',
                  <textarea className={`${inputCls} resize-none`} rows={2} placeholder="What does this secret contain? Who uses it?"
                    value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
                )}
              </div>

              {/* Vault / Store */}
              <div className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Vault / Secret Store</p>
                <div className="grid grid-cols-2 gap-3">
                  {field('Secret Store Name',
                    <input className={inputCls} placeholder="vault-backend" value={form.secretStore}
                      onChange={e => setForm(f => ({ ...f, secretStore: e.target.value }))} />,
                    'Name of the SecretStore or ClusterSecretStore resource in the cluster.'
                  )}
                  {field('Store Kind',
                    <select className={selectCls} value={form.secretStoreKind}
                      onChange={e => setForm(f => ({ ...f, secretStoreKind: e.target.value as typeof form.secretStoreKind }))}>
                      <option value="ClusterSecretStore">ClusterSecretStore</option>
                      <option value="SecretStore">SecretStore</option>
                    </select>
                  )}
                </div>
                {field('Vault Path *',
                  <input className={inputCls} placeholder="myapp/db" value={form.remoteRef}
                    onChange={e => setForm(f => ({ ...f, remoteRef: e.target.value }))} />,
                  'KV v2 path relative to the "secret" mount (e.g. "myapp/db"). Values will be written here.'
                )}
              </div>

              {/* Target & refresh */}
              <div className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Sync Options</p>
                <div className="grid grid-cols-2 gap-3">
                  {field('Target K8s Secret Name',
                    <input className={inputCls} placeholder={form.name || 'same as name above'} value={form.targetSecretName}
                      onChange={e => setForm(f => ({ ...f, targetSecretName: e.target.value }))} />,
                    'Leave blank to use the same name as the ExternalSecret.'
                  )}
                  {field('Refresh Interval',
                    <select className={selectCls} value={form.refreshInterval}
                      onChange={e => setForm(f => ({ ...f, refreshInterval: e.target.value }))}>
                      <option value="5m">5 minutes</option>
                      <option value="15m">15 minutes</option>
                      <option value="1h">1 hour</option>
                      <option value="6h">6 hours</option>
                      <option value="24h">24 hours</option>
                      <option value="168h">1 week</option>
                    </select>,
                    'How often ESO re-syncs from Vault.'
                  )}
                </div>
              </div>

              {/* Secret values — written to Vault, never stored in DB */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Secret Values</p>
                    <p className="text-[10px] text-text-muted mt-0.5">Sent directly to Vault · never stored in ORION</p>
                  </div>
                  <button onClick={addValueRow} className="inline-flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 transition-colors">
                    <Plus size={10} /> Add key
                  </button>
                </div>
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-[10px] text-text-muted px-0.5">
                    <span>Vault key</span>
                    <span>Value <span className="text-accent">*</span></span>
                    <span>K8s key (optional)</span>
                    <span />
                  </div>
                  {secretValues.map((row, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                      <input className={inputCls} placeholder="password" value={row.vaultKey}
                        onChange={e => updateValueRow(i, 'vaultKey', e.target.value)} />
                      <input className={inputCls} type="password" placeholder="••••••••" value={row.value}
                        onChange={e => updateValueRow(i, 'value', e.target.value)}
                        autoComplete="new-password" />
                      <input className={inputCls} placeholder={row.vaultKey || 'DB_PASSWORD'} value={row.k8sKey}
                        onChange={e => updateValueRow(i, 'k8sKey', e.target.value)} />
                      <button onClick={() => removeValueRow(i)} disabled={secretValues.length === 1}
                        className="p-1 rounded text-text-muted hover:text-status-error transition-colors disabled:opacity-30">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tags */}
              {field('Tags',
                <input className={inputCls} placeholder="database, production, myapp" value={form.tags}
                  onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />,
                'Comma-separated labels for filtering and discovery.'
              )}
            </div>

            {/* Modal footer */}
            {modalError && (
              <div className="px-5 py-2 border-t border-status-error/30 bg-status-error/10 text-xs text-status-error flex items-center gap-2 flex-shrink-0">
                <ServerCrash size={12} />
                <span>{modalError}</span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle flex-shrink-0">
              <button onClick={() => setShowModal(false)} className="px-3 py-1.5 rounded text-xs border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30 disabled:opacity-50 flex items-center gap-1.5 transition-colors">
                {saving ? <RefreshCw size={11} className="animate-spin" /> : <KeyRound size={11} />}
                {saving ? 'Writing to Vault…' : 'Write to Vault'}
              </button>
            </div>
          </div>
        </div>
      )}
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
