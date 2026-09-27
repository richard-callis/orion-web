'use client'

import { Fragment, useState } from 'react'
import useSWR from 'swr'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { IconButton } from '@/components/ui/Button'
import { RefreshCw, ServerCrash, KeyRound, Plus, X, Trash2, ChevronDown, ChevronUp, Pencil } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import type { ManagedSecret } from '../types'

export const BLANK_FORM = {
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

export const STATUS_COLORS: Record<string, string> = {
  draft:   'text-text-muted border-border-subtle',
  applied: 'text-status-healthy border-status-healthy/30 bg-status-healthy/10',
  error:   'text-status-error border-status-error/30 bg-status-error/10',
}

export function SecretsTab({ envId }: { envId: string }) {
  const secretsKey = envId ? `/api/environments/${envId}/secrets` : null
  const { data, error: loadError, isValidating: loading, mutate } =
    useSWR<{ secrets?: ManagedSecret[] }>(secretsKey, { revalidateOnFocus: false })
  const secrets = data?.secrets ?? []
  const error = loadError ? errorMessage(loadError) : null
  const load = () => mutate()
  const toast = useToast()
  const confirm = useConfirm()
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
  // `existing` rows mirror keys already in Vault: a blank value keeps the current value.
  const [editValues, setEditValues] = useState<Array<{ vaultKey: string; value: string; k8sKey: string; existing?: boolean }>>([])
  const [editRemoved, setEditRemoved] = useState<string[]>([])
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)


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
      await apiFetch(`/api/environments/${envId}/secrets`, {
        method: 'POST',
        body: {
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
        },
      })
      setShowModal(false)
      await load()
    } catch (e) {
      setModalError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (s: ManagedSecret) => {
    const ok = await confirm({
      title: `Delete ${s.name}?`,
      message: 'This removes the ExternalSecret record from ORION. Values already in Vault are not deleted.',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    const id = s.id
    setDeleting(id)
    try {
      await apiFetch(`/api/environments/${envId}/secrets/${id}`, { method: 'DELETE' })
      await mutate(prev => prev && { ...prev, secrets: prev.secrets?.filter(s => s.id !== id) }, { revalidate: false })
      if (expandedId === id) setExpandedId(null)
    } catch (e) {
      toast.error(`Failed to delete secret: ${errorMessage(e)}`)
    } finally {
      setDeleting(null)
    }
  }

  const openEditModal = (s: ManagedSecret) => {
    // Pre-populate key names from dataKeys; values start blank (never stored)
    setEditValues(
      s.dataKeys.length > 0
        ? s.dataKeys.map(k => ({ vaultKey: k.remoteKey, value: '', k8sKey: k.secretKey, existing: true }))
        : [{ vaultKey: '', value: '', k8sKey: '' }]
    )
    setEditRemoved([])
    setEditError(null)
    setEditSecret(s)
  }

  const handleEditSave = async () => {
    if (!editSecret) return
    // Blank value on an existing key = keep it (only the k8s mapping may change).
    // New keys need a value. Keys are deleted only via the explicit remove list.
    const rows = editValues.filter(r => r.vaultKey.trim())
    const missing = rows.filter(r => !r.existing && !r.value)
    if (missing.length > 0) { setEditError(`Enter a value for new key: ${missing.map(r => r.vaultKey.trim()).join(', ')}`); return }
    const secretValues = rows.map(({ vaultKey, value, k8sKey }) => ({ vaultKey: vaultKey.trim(), value, k8sKey }))
    const changed = rows.some(r => r.value) || editRemoved.length > 0 ||
      rows.some(r => {
        const orig = editSecret.dataKeys.find(k => k.remoteKey === r.vaultKey.trim())
        return !orig || (r.k8sKey.trim() || r.vaultKey.trim()) !== orig.secretKey
      })
    if (!changed) { setEditError('Nothing to update — enter a new value, change a mapping, or remove a key'); return }

    setEditSaving(true); setEditError(null)
    try {
      await apiFetch(`/api/environments/${envId}/secrets/${editSecret.id}`, {
        method: 'PATCH',
        body: { secretValues, removeKeys: editRemoved },
      })
      setEditSecret(null)
      await load()
    } catch (e) {
      setEditError(errorMessage(e))
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
              <Fragment key={s.id}>
                <tr
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
                      <IconButton
                        label={expandedId === s.id ? `Collapse ${s.name}` : `Expand ${s.name}`}
                        aria-expanded={expandedId === s.id}
                        onClick={e => { e.stopPropagation(); setExpandedId(expandedId === s.id ? null : s.id) }}
                      >
                        {expandedId === s.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </IconButton>
                      <IconButton
                        label={`Update ${s.name} values in Vault`}
                        onClick={e => { e.stopPropagation(); openEditModal(s) }}
                        className="hover:text-accent"
                      >
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton
                        label={`Delete ${s.name}`}
                        onClick={e => { e.stopPropagation(); handleDelete(s) }}
                        disabled={deleting === s.id}
                        className="hover:text-status-error disabled:opacity-40"
                      >
                        <Trash2 size={12} />
                      </IconButton>
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
              </Fragment>
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
        <Dialog
          onClose={() => setEditSecret(null)}
          label="Update secret values"
          className="w-full max-w-lg bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
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
              Current values stay in Vault — leave a value blank to keep it, or enter a new one to rotate just that key.
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
                  <span>New value</span>
                  <span>K8s key (optional)</span>
                  <span />
                </div>
                {editValues.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                    <input
                      className="w-full px-2.5 py-1.5 rounded border border-border-visible bg-bg-raised text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                      placeholder="password"
                      value={row.vaultKey}
                      readOnly={row.existing}
                      aria-label="Vault key"
                      onChange={e => setEditValues(prev => prev.map((r, idx) => idx === i ? { ...r, vaultKey: e.target.value } : r))}
                    />
                    <input
                      className="w-full px-2.5 py-1.5 rounded border border-border-visible bg-bg-raised text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                      type="password"
                      placeholder={row.existing ? 'unchanged' : 'value (required)'}
                      aria-label={`New value for ${row.vaultKey || 'new key'}`}
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
                      onClick={() => {
                        if (row.existing && row.vaultKey.trim()) setEditRemoved(prev => [...prev, row.vaultKey.trim()])
                        setEditValues(prev => prev.filter((_, idx) => idx !== i))
                      }}
                      aria-label={row.existing ? `Delete ${row.vaultKey} from Vault` : 'Remove row'}
                      title={row.existing ? 'Delete this key from Vault' : 'Remove row'}
                      className="p-1 rounded text-text-muted hover:text-status-error transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              {editRemoved.length > 0 && (
                <div className="rounded border border-status-error/30 bg-status-error/10 px-3 py-2 text-[10px] text-status-error flex items-center justify-between gap-2">
                  <span>Will be <strong>deleted</strong> from Vault: <span className="font-mono">{editRemoved.join(', ')}</span></span>
                  <button
                    onClick={() => {
                      const orig = editSecret.dataKeys
                      setEditValues(prev => [...prev, ...editRemoved.map(k => ({ vaultKey: k, value: '', k8sKey: orig.find(d => d.remoteKey === k)?.secretKey ?? '', existing: true }))])
                      setEditRemoved([])
                    }}
                    className="underline hover:no-underline"
                  >
                    Undo
                  </button>
                </div>
              )}
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
        </Dialog>
      )}

      {/* Add Secret Modal */}
      {showModal && (
        <Dialog
          onClose={() => setShowModal(false)}
          label="Add external secret"
          className="w-full max-w-xl bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
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
        </Dialog>
      )}
    </div>
  )
}

// ── Backups tab ────────────────────────────────────────────────────────────────
