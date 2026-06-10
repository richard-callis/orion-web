'use client'

import { useEffect, useState, useCallback } from 'react'
import { Webhook, Plus, Trash2, RefreshCw, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react'

type Agent = { id: string; name: string }

type WebhookTrigger = {
  id: string
  name: string
  source: string
  agentId: string
  agent: Agent
  taskTitle: string
  taskDesc: string | null
  enabled: boolean
  lastFiredAt: string | null
  fireCount: number
  createdAt: string
  // only present at creation or regeneration
  secret?: string
}

const SOURCE_OPTIONS = [
  { value: 'github',        label: 'GitHub' },
  { value: 'prometheus',    label: 'Prometheus' },
  { value: 'alertmanager',  label: 'Alertmanager' },
  { value: 'custom',        label: 'Custom' },
]

const SOURCE_VARS: Record<string, string> = {
  github:       '{{event}}, {{repo}}, {{branch}}, {{pusher}}, {{commit}}',
  prometheus:   '{{event}}, {{alert}}, {{severity}}, {{status}}',
  alertmanager: '{{event}}, {{alert}}, {{severity}}, {{status}}',
  custom:       '{{event}}, {{payload}}',
}

const SOURCE_CURL: Record<string, (url: string, secret: string) => string> = {
  github: (url, secret) =>
    `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Hub-Signature-256: sha256=<hmac-sha256-of-body>" \\\n  -d '{"ref":"refs/heads/main","repository":{"name":"my-repo"},"pusher":{"name":"alice"}}'`,
  prometheus: (url, secret) =>
    `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Secret: ${secret}" \\\n  -d '{"alerts":[{"labels":{"alertname":"HighCPU","severity":"warning"},"status":"firing"}]}'`,
  alertmanager: (url, secret) =>
    `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Secret: ${secret}" \\\n  -d '{"alerts":[{"labels":{"alertname":"DiskFull","severity":"critical"},"status":"firing"}]}'`,
  custom: (url, secret) =>
    `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Secret: ${secret}" \\\n  -d '{"hello":"world"}'`,
}

function sourceBadgeClass(source: string): string {
  switch (source) {
    case 'github':       return 'bg-gray-700 text-gray-200'
    case 'prometheus':   return 'bg-orange-900/60 text-orange-300'
    case 'alertmanager': return 'bg-red-900/60 text-red-300'
    default:             return 'bg-accent/20 text-accent'
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={handleCopy} className="p-1 rounded hover:bg-bg-raised text-text-muted hover:text-text-primary transition-colors" title="Copy">
      {copied ? <Check size={14} className="text-status-healthy" /> : <Copy size={14} />}
    </button>
  )
}

export default function WebhookTriggersPage() {
  const [triggers, setTriggers] = useState<WebhookTrigger[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({})

  // Form state
  const [form, setForm] = useState({
    name: '',
    agentId: '',
    source: 'custom',
    taskTitle: '',
    taskDesc: '',
  })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const loadTriggers = useCallback(async () => {
    const res = await fetch('/api/webhook-triggers')
    if (res.ok) setTriggers(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => {
    loadTriggers()
    fetch('/api/agents').then(r => r.json()).then(setAgents)
  }, [loadTriggers])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/webhook-triggers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const err = await res.json()
        setCreateError(err.error ?? 'Failed to create')
        return
      }
      const created: WebhookTrigger = await res.json()
      setTriggers(prev => [created, ...prev])
      if (created.secret) {
        setRevealedSecrets(prev => ({ ...prev, [created.id]: created.secret! }))
      }
      setExpandedId(created.id)
      setShowForm(false)
      setForm({ name: '', agentId: '', source: 'custom', taskTitle: '', taskDesc: '' })
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this webhook trigger?')) return
    await fetch(`/api/webhook-triggers/${id}`, { method: 'DELETE' })
    setTriggers(prev => prev.filter(t => t.id !== id))
  }

  async function handleToggleEnabled(trigger: WebhookTrigger) {
    const res = await fetch(`/api/webhook-triggers/${trigger.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !trigger.enabled }),
    })
    if (res.ok) {
      const updated: WebhookTrigger = await res.json()
      setTriggers(prev => prev.map(t => (t.id === updated.id ? { ...t, enabled: updated.enabled } : t)))
    }
  }

  async function handleRegenerateSecret(id: string) {
    if (!confirm('Regenerate the secret? The old secret will stop working immediately.')) return
    const res = await fetch(`/api/webhook-triggers/${id}/regenerate-secret`, { method: 'POST' })
    if (res.ok) {
      const { secret } = await res.json()
      setRevealedSecrets(prev => ({ ...prev, [id]: secret }))
    }
  }

  const getOrigin = () => (typeof window !== 'undefined' ? window.location.origin : '')

  return (
    <div className="p-4 lg:p-6 space-y-4 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Webhook size={20} className="text-accent" />
          <h1 className="text-lg font-semibold text-text-primary">Webhook Triggers</h1>
          <span className="text-sm text-text-muted">{triggers.length} configured</span>
        </div>
        <button
          onClick={() => setShowForm(f => !f)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-bg-primary text-sm font-medium hover:bg-accent/90 transition-colors"
        >
          <Plus size={15} />
          New Trigger
        </button>
      </div>

      {/* Creation form */}
      {showForm && (
        <form onSubmit={handleCreate} className="rounded-lg border border-accent/40 bg-bg-raised p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text-primary">New Webhook Trigger</h2>
          {createError && <p className="text-xs text-status-error">{createError}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">Name</span>
              <input
                required
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="px-2 py-1.5 rounded bg-bg-primary border border-border-subtle text-sm text-text-primary focus:outline-none focus:border-accent"
                placeholder="My GitHub Webhook"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">Agent</span>
              <select
                required
                value={form.agentId}
                onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))}
                className="px-2 py-1.5 rounded bg-bg-primary border border-border-subtle text-sm text-text-primary focus:outline-none focus:border-accent"
              >
                <option value="">Select agent…</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">Source</span>
              <select
                value={form.source}
                onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
                className="px-2 py-1.5 rounded bg-bg-primary border border-border-subtle text-sm text-text-primary focus:outline-none focus:border-accent"
              >
                {SOURCE_OPTIONS.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">
                Task Title Template
                <span className="ml-1 text-text-muted opacity-70">({SOURCE_VARS[form.source]})</span>
              </span>
              <input
                required
                value={form.taskTitle}
                onChange={e => setForm(f => ({ ...f, taskTitle: e.target.value }))}
                className="px-2 py-1.5 rounded bg-bg-primary border border-border-subtle text-sm text-text-primary focus:outline-none focus:border-accent"
                placeholder="Push to {{repo}}/{{branch}}"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">Task Description Template (optional)</span>
            <textarea
              rows={2}
              value={form.taskDesc}
              onChange={e => setForm(f => ({ ...f, taskDesc: e.target.value }))}
              className="px-2 py-1.5 rounded bg-bg-primary border border-border-subtle text-sm text-text-primary focus:outline-none focus:border-accent resize-none"
              placeholder="Investigate push by {{pusher}} to {{branch}}"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating}
              className="px-3 py-1.5 rounded bg-accent text-bg-primary text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-3 py-1.5 rounded border border-border-subtle text-sm text-text-secondary hover:bg-bg-raised transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Table */}
      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : triggers.length === 0 ? (
        <div className="rounded-lg border border-border-subtle p-8 text-center">
          <Webhook size={32} className="mx-auto mb-2 text-text-muted opacity-40" />
          <p className="text-sm text-text-muted">No webhook triggers yet. Create one above.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-raised border-b border-border-subtle">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Name</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Source</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Agent</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Last Fired</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Fires</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-text-muted">Enabled</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {triggers.map(trigger => {
                const expanded = expandedId === trigger.id
                const webhookUrl = `${getOrigin()}/api/webhooks/${trigger.id}`
                const revealedSecret = revealedSecrets[trigger.id]

                return (
                  <>
                    <tr key={trigger.id} className="hover:bg-bg-raised cursor-pointer" onClick={() => setExpandedId(expanded ? null : trigger.id)}>
                      <td className="px-3 py-2.5 font-medium text-text-primary flex items-center gap-1.5">
                        {expanded ? <ChevronUp size={14} className="text-text-muted flex-shrink-0" /> : <ChevronDown size={14} className="text-text-muted flex-shrink-0" />}
                        {trigger.name}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${sourceBadgeClass(trigger.source)}`}>
                          {trigger.source}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-text-secondary">{trigger.agent?.name ?? '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-text-muted">
                        {trigger.lastFiredAt ? new Date(trigger.lastFiredAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono text-text-muted">{trigger.fireCount}</td>
                      <td className="px-3 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => handleToggleEnabled(trigger)}
                          className={`w-8 h-4 rounded-full transition-colors relative ${trigger.enabled ? 'bg-accent' : 'bg-bg-raised border border-border-subtle'}`}
                          title={trigger.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                        >
                          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${trigger.enabled ? 'right-0.5' : 'left-0.5'}`} />
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => handleDelete(trigger.id)}
                          className="p-1 rounded hover:bg-status-error/20 text-text-muted hover:text-status-error transition-colors"
                          title="Delete trigger"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>

                    {expanded && (
                      <tr key={`${trigger.id}-detail`} className="bg-bg-raised">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="space-y-3 text-sm">
                            {/* Webhook URL */}
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Webhook URL</p>
                              <div className="flex items-center gap-2 font-mono text-xs bg-bg-primary border border-border-subtle rounded px-2 py-1.5">
                                <span className="flex-1 break-all text-text-primary">{webhookUrl}</span>
                                <CopyButton text={webhookUrl} />
                              </div>
                            </div>

                            {/* Secret */}
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Secret</p>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 flex items-center gap-2 font-mono text-xs bg-bg-primary border border-border-subtle rounded px-2 py-1.5">
                                  <span className="flex-1 text-text-secondary">
                                    {revealedSecret ?? '••••••••••••••••••••••••••••••••'}
                                  </span>
                                  {revealedSecret && <CopyButton text={revealedSecret} />}
                                </div>
                                <button
                                  onClick={() => handleRegenerateSecret(trigger.id)}
                                  className="flex items-center gap-1 px-2 py-1.5 rounded border border-border-subtle text-xs text-text-secondary hover:bg-bg-raised hover:text-text-primary transition-colors"
                                  title="Generate a new secret"
                                >
                                  <RefreshCw size={12} />
                                  {revealedSecret ? 'Regenerate' : 'Reveal / Regenerate'}
                                </button>
                              </div>
                            </div>

                            {/* Example curl */}
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Example curl</p>
                              <div className="relative">
                                <pre className="font-mono text-xs bg-bg-primary border border-border-subtle rounded px-3 py-2 overflow-x-auto text-text-secondary whitespace-pre">
                                  {SOURCE_CURL[trigger.source]?.(webhookUrl, revealedSecret ?? '<your-secret>') ?? ''}
                                </pre>
                                <div className="absolute top-1.5 right-1.5">
                                  <CopyButton text={SOURCE_CURL[trigger.source]?.(webhookUrl, revealedSecret ?? '<your-secret>') ?? ''} />
                                </div>
                              </div>
                            </div>

                            {/* Template */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <p className="text-xs text-text-muted mb-1 font-medium">Task Title Template</p>
                                <p className="text-xs font-mono bg-bg-primary border border-border-subtle rounded px-2 py-1.5 text-text-primary">{trigger.taskTitle}</p>
                              </div>
                              {trigger.taskDesc && (
                                <div>
                                  <p className="text-xs text-text-muted mb-1 font-medium">Task Description Template</p>
                                  <p className="text-xs font-mono bg-bg-primary border border-border-subtle rounded px-2 py-1.5 text-text-secondary whitespace-pre-wrap">{trigger.taskDesc}</p>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
