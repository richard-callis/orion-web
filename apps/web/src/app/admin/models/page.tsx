'use client'
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Check, X, RefreshCw, Lock, AlertTriangle } from 'lucide-react'

interface ExternalModel {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey: string | null
  modelId: string
  enabled: boolean
  timeoutSecs: number
}

interface Health {
  claude: boolean
  externalModels?: Record<string, boolean>
}

interface ModelForm {
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  modelId: string
  enabled: boolean
  timeoutSecs: number
}

const EMPTY_FORM: ModelForm = { name: '', provider: 'openai', baseUrl: '', apiKey: '', modelId: '', enabled: true, timeoutSecs: 120 }

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI Compatible',
  ollama: 'Remote Ollama',
  anthropic: 'Anthropic',
  custom: 'Custom',
}

const PROVIDER_DEFAULTS: Record<string, Partial<ModelForm>> = {
  openai:    { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o' },
  ollama:    { baseUrl: 'http://10.2.2.34:30068', modelId: 'llama3.2:3b' },
  anthropic: { baseUrl: 'https://api.anthropic.com', modelId: 'claude-sonnet-4-6' },
  custom:    { baseUrl: '', modelId: '' },
}

const BUILT_INS = [
  {
    id: '__claude',
    name: 'Claude (Anthropic)',
    provider: 'anthropic',
    description: 'claude-sonnet-4-6 · via Claude Code SDK',
    settingsHref: '/admin/settings',
    healthKey: 'claude' as const,
  },
]

const inputCls = 'w-full px-3 py-1.5 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors'

function FormField({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      {children}
    </div>
  )
}

function StatusBadge({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return <span className="text-xs text-text-muted">Checking…</span>
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
      ok ? 'bg-status-healthy/15 text-status-healthy' : 'bg-status-error/15 text-status-error'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-status-healthy' : 'bg-status-error'}`} />
      {ok ? 'Connected' : 'Unavailable'}
    </span>
  )
}

interface ModelModalProps {
  model: ExternalModel | null   // null = "add new"
  health: Health | null
  onClose: () => void
  onSaved: () => void
  onDeleted: (id: string) => void
}

function ModelModal({ model, health, onClose, onSaved, onDeleted }: ModelModalProps) {
  const isNew = model === null
  const [form, setForm] = useState<ModelForm>(
    model
      ? { name: model.name, provider: model.provider, baseUrl: model.baseUrl, apiKey: '', modelId: model.modelId, enabled: model.enabled, timeoutSecs: model.timeoutSecs ?? 120 }
      : EMPTY_FORM
  )
  const [saving, setSaving]         = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const handleProviderChange = (provider: string) => {
    setForm(f => ({ ...f, provider, ...PROVIDER_DEFAULTS[provider] }))
  }

  const handleSave = async () => {
    if (!form.name || !form.baseUrl || !form.modelId) { setError('Name, Base URL, and Model ID are required.'); return }
    setSaving(true); setError(null)
    try {
      const payload = { name: form.name, provider: form.provider, baseUrl: form.baseUrl, apiKey: form.apiKey || undefined, modelId: form.modelId, enabled: form.enabled, timeoutSecs: form.timeoutSecs }
      const res = model
        ? await fetch(`/api/admin/models/${model.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/admin/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) throw new Error(await res.text())
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!model) return
    setDeleting(true)
    await fetch(`/api/admin/models/${model.id}`, { method: 'DELETE' })
    onDeleted(model.id)
  }

  // Close on backdrop click
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const connectionOk = model ? health?.externalModels?.[`ext:${model.id}`] : undefined

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="relative w-full max-w-lg mx-4 rounded-xl border border-border-subtle bg-bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              {isNew ? 'Add External Model' : 'Edit Model'}
            </h2>
            {!isNew && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-text-muted">{PROVIDER_LABELS[model!.provider] ?? model!.provider}</span>
                <span className="text-text-muted">·</span>
                <StatusBadge ok={connectionOk} />
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-text-muted hover:text-text-primary transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Display Name">
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My GPT-4o"
                className={inputCls}
                autoFocus
              />
            </FormField>
            <FormField label="Provider">
              <select value={form.provider} onChange={e => handleProviderChange(e.target.value)} className={inputCls}>
                {Object.entries(PROVIDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </FormField>
            <FormField label="Base URL">
              <input
                value={form.baseUrl}
                onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://api.openai.com/v1"
                className={inputCls}
              />
            </FormField>
            <FormField label="Model ID">
              <input
                value={form.modelId}
                onChange={e => setForm(f => ({ ...f, modelId: e.target.value }))}
                placeholder="gpt-4o"
                className={inputCls}
              />
            </FormField>
            {form.provider !== 'ollama' && (
              <FormField label="API Key" className="col-span-2">
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                  placeholder={!isNew ? 'Leave blank to keep existing key' : 'sk-...'}
                  className={inputCls}
                  autoComplete="off"
                />
              </FormField>
            )}
            <FormField label="Timeout (seconds)">
              <input
                type="number"
                min={10}
                max={3600}
                value={form.timeoutSecs}
                onChange={e => setForm(f => ({ ...f, timeoutSecs: Math.max(10, parseInt(e.target.value) || 120) }))}
                className={inputCls}
              />
            </FormField>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setForm(f => ({ ...f, enabled: !f.enabled }))}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.enabled ? 'bg-accent' : 'bg-bg-raised border border-border-subtle'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${form.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
            <span className="text-xs text-text-secondary">Enabled</span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border-subtle">
          {/* Delete section */}
          <div>
            {!isNew && !confirmDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-status-error hover:bg-status-error/10 transition-colors"
              >
                <Trash2 size={12} /> Delete
              </button>
            )}
            {confirmDelete && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted">Sure?</span>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex items-center gap-1 px-3 py-1.5 rounded bg-status-error text-white text-xs font-medium hover:bg-status-error/90 transition-colors disabled:opacity-50"
                >
                  {deleting ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  {deleting ? 'Deleting…' : 'Yes, delete'}
                </button>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-text-muted hover:text-text-secondary">
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Save / Cancel */}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-4 py-1.5 rounded border border-border-subtle text-sm text-text-secondary hover:text-text-primary transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-1.5 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ModelsPage() {
  const [models, setModels]   = useState<ExternalModel[]>([])
  const [health, setHealth]   = useState<Health | null>(null)
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState<'add' | ExternalModel | null>(null)

  const load = useCallback(() => {
    Promise.all([
      fetch('/api/admin/models').then(r => r.json()),
      fetch('/api/health').then(r => r.json()).catch(() => null),
    ]).then(([data, h]) => {
      setModels(data)
      setHealth(h)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const handleSaved = () => { load(); setModal(null) }
  const handleDeleted = (id: string) => { setModels(m => m.filter(x => x.id !== id)); setModal(null) }

  const toggleEnabled = async (e: React.MouseEvent, m: ExternalModel) => {
    e.stopPropagation()
    const res = await fetch(`/api/admin/models/${m.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !m.enabled }) })
    if (res.ok) { const updated: ExternalModel = await res.json(); setModels(prev => prev.map(x => x.id === m.id ? updated : x)) }
  }

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      {/* Modal */}
      {modal !== null && (
        <ModelModal
          model={modal === 'add' ? null : modal}
          health={health}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}

      <div>
        <h1 className="text-lg font-semibold text-text-primary">Models</h1>
        <p className="text-sm text-text-muted mt-0.5">Built-in and external LLM providers available to this application</p>
      </div>

      {/* Built-in models */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Built-in</h2>
        <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden divide-y divide-border-subtle">
          {BUILT_INS.map(b => (
            <div key={b.id} className="flex items-center gap-4 px-4 py-3">
              <Lock size={13} className="text-text-muted flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{b.name}</p>
                <p className="text-xs text-text-muted mt-0.5 truncate">{b.description}</p>
              </div>
              <StatusBadge ok={health?.[b.healthKey]} />
              {b.settingsHref && (
                <a href={b.settingsHref} className="text-xs text-accent hover:underline">Configure</a>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* External / configurable models */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wide">External</h2>
          <button
            onClick={() => setModal('add')}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
          >
            <Plus size={13} /> Add Model
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-text-muted text-sm"><RefreshCw size={14} className="animate-spin" />Loading…</div>
        ) : models.length === 0 ? (
          <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
            No external models configured. Add one to make it available in the chat model selector.
          </div>
        ) : (
          <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border-subtle bg-bg-raised">
                <tr>
                  {['Name', 'Provider', 'Base URL', 'Model ID', 'Connection', 'Enabled'].map(h => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {models.map(m => (
                  <tr
                    key={m.id}
                    onClick={() => setModal(m)}
                    className="hover:bg-bg-raised transition-colors cursor-pointer"
                    title="Click to edit"
                  >
                    <td className="px-4 py-3 text-text-primary font-medium">{m.name}</td>
                    <td className="px-4 py-3 text-text-secondary text-xs">{PROVIDER_LABELS[m.provider] ?? m.provider}</td>
                    <td className="px-4 py-3 text-text-muted font-mono text-xs truncate max-w-[160px]">{m.baseUrl}</td>
                    <td className="px-4 py-3 text-text-secondary font-mono text-xs">{m.modelId}</td>
                    <td className="px-4 py-3">
                      <StatusBadge ok={health?.externalModels?.[`ext:${m.id}`]} />
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={e => toggleEnabled(e, m)} title="Toggle enabled">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${m.enabled ? 'bg-status-healthy/15 text-status-healthy' : 'bg-bg-raised text-text-muted'}`}>
                          {m.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
