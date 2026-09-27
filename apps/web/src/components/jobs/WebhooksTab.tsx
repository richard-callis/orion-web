'use client'
import { Fragment, useState } from 'react'
import useSWR from 'swr'
import { Plus, Trash2, Webhook, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { apiFetch, errorMessage } from '@/lib/api'
import { useAgents } from '@/hooks/useAgents'
import { IconButton } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { ConfirmInline, CopyButton, type WebhookTrigger } from './job-types'
import { Textarea } from '@/components/ui/Textarea'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

const SOURCE_OPTIONS = [
  { value: 'github',       label: 'GitHub' },
  { value: 'prometheus',   label: 'Prometheus' },
  { value: 'alertmanager', label: 'Alertmanager' },
  { value: 'custom',       label: 'Custom' },
]

const SOURCE_VARS: Record<string, string> = {
  github:       '{{event}}, {{repo}}, {{branch}}, {{pusher}}, {{commit}}',
  prometheus:   '{{event}}, {{alert}}, {{severity}}, {{status}}',
  alertmanager: '{{event}}, {{alert}}, {{severity}}, {{status}}',
  custom:       '{{event}}, {{payload}}',
}

const SOURCE_CURL: Record<string, (url: string, secret: string) => string> = {
  github:       (url) => `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Hub-Signature-256: sha256=<hmac-sha256-of-body>" \\\n  -d '{"ref":"refs/heads/main","repository":{"name":"my-repo"},"pusher":{"name":"alice"}}'`,
  prometheus:   (url, s) => `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Secret: ${s}" \\\n  -d '{"alerts":[{"labels":{"alertname":"HighCPU","severity":"warning"},"status":"firing"}]}'`,
  alertmanager: (url, s) => `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Secret: ${s}" \\\n  -d '{"alerts":[{"labels":{"alertname":"DiskFull","severity":"critical"},"status":"firing"}]}'`,
  custom:       (url, s) => `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Secret: ${s}" \\\n  -d '{"hello":"world"}'`,
}

function sourceBadgeCls(source: string) {
  switch (source) {
    case 'github':       return 'bg-gray-700 text-gray-200'
    case 'prometheus':   return 'bg-orange-900/60 text-orange-300'
    case 'alertmanager': return 'bg-red-900/60 text-red-300'
    default:             return 'bg-accent/20 text-accent'
  }
}
const EMPTY_FORM = { name: '', agentId: '', source: 'custom', taskTitle: '', taskDesc: '' }

export function WebhooksTab() {
  const toast = useToast()
  const { data: triggers = [], isLoading, mutate } = useSWR<WebhookTrigger[]>('/api/webhook-triggers')
  const { agents } = useAgents()
  const [showForm, setShowForm] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({})
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [pendingRegen, setPendingRegen] = useState<string | null>(null)

  const update = (fn: (list: WebhookTrigger[]) => WebhookTrigger[]) => mutate(prev => fn(prev ?? []), { revalidate: false })

  const remove = async (id: string) => {
    setPendingDelete(null)
    try {
      await apiFetch(`/api/webhook-triggers/${id}`, { method: 'DELETE' })
      await update(list => list.filter(t => t.id !== id))
    } catch (e) {
      toast.error(`Failed to delete trigger: ${errorMessage(e)}`)
    }
  }

  const toggle = async (trigger: WebhookTrigger) => {
    try {
      const u = await apiFetch<WebhookTrigger>(`/api/webhook-triggers/${trigger.id}`, { method: 'PUT', body: { enabled: !trigger.enabled } })
      await update(list => list.map(t => t.id === u.id ? { ...t, enabled: u.enabled } : t))
    } catch (e) {
      toast.error(`Failed to update trigger: ${errorMessage(e)}`)
    }
  }

  const regenerate = async (id: string) => {
    setPendingRegen(null)
    try {
      const { secret } = await apiFetch<{ secret: string }>(`/api/webhook-triggers/${id}/regenerate-secret`, { method: 'POST' })
      setRevealedSecrets(prev => ({ ...prev, [id]: secret }))
    } catch (e) {
      toast.error(`Failed to regenerate secret: ${errorMessage(e)}`)
    }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">{triggers.length} trigger{triggers.length !== 1 ? 's' : ''} configured</p>
        <button onClick={() => setShowForm(f => !f)} aria-expanded={showForm} className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm bg-accent text-bg-primary text-sm font-medium hover:bg-accent/90 transition-colors">
          <Plus size={15} /> New Trigger
        </button>
      </div>

      {showForm && (
        <NewTriggerForm
          agents={agents}
          onCancel={() => setShowForm(false)}
          onCreated={created => {
            void update(list => [created, ...list])
            if (created.secret) setRevealedSecrets(prev => ({ ...prev, [created.id]: created.secret! }))
            setExpandedId(created.id)
            setShowForm(false)
          }}
        />
      )}

      {isLoading ? <p className="text-sm text-text-muted">Loading…</p> : triggers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <Webhook size={32} className="text-text-muted/40" />
          <p className="text-sm font-medium text-text-secondary">No webhook triggers yet</p>
          <p className="text-xs text-text-muted max-w-xs">Connect external systems to kick off agents automatically. Click <strong>+ New Trigger</strong> to create one.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-raised border-b border-border-subtle"><tr>
              {['Name', 'Source', 'Agent', 'Last Fired', 'Fires'].map(h => <th key={h} className="px-3 py-2 text-left text-xs font-medium text-text-muted">{h}</th>)}
              <th className="px-3 py-2 text-center text-xs font-medium text-text-muted">Enabled</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-text-muted">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-border-subtle">
              {triggers.map(trigger => {
                const expanded = expandedId === trigger.id
                const webhookUrl = `${origin}/api/webhooks/${trigger.id}`
                const revealedSecret = revealedSecrets[trigger.id]
                const curl = SOURCE_CURL[trigger.source]?.(webhookUrl, revealedSecret ?? '<your-secret>') ?? ''
                return (
                  <Fragment key={trigger.id}>
                    <tr className="hover:bg-bg-raised">
                      <td className="px-3 py-2.5 font-medium text-text-primary">
                        <button
                          onClick={() => setExpandedId(expanded ? null : trigger.id)}
                          aria-expanded={expanded}
                          className="flex items-center gap-1.5 text-left"
                        >
                          {expanded ? <ChevronUp size={14} className="text-text-muted shrink-0" /> : <ChevronDown size={14} className="text-text-muted shrink-0" />}
                          {trigger.name}
                        </button>
                      </td>
                      <td className="px-3 py-2.5"><span className={`px-1.5 py-0.5 rounded-sm text-xs font-medium ${sourceBadgeCls(trigger.source)}`}>{trigger.source}</span></td>
                      <td className="px-3 py-2.5 text-text-secondary">{trigger.agent?.name ?? '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-text-muted">{trigger.lastFiredAt ? new Date(trigger.lastFiredAt).toLocaleString() : '—'}</td>
                      <td className="px-3 py-2.5 text-xs font-mono text-text-muted">{trigger.fireCount}</td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          role="switch"
                          aria-checked={trigger.enabled}
                          aria-label={`Enable ${trigger.name}`}
                          onClick={() => void toggle(trigger)}
                          className={`w-8 h-4 rounded-full transition-colors relative ${trigger.enabled ? 'bg-accent' : 'bg-bg-raised border border-border-subtle'}`}
                        >
                          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${trigger.enabled ? 'right-0.5' : 'left-0.5'}`} />
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {pendingDelete === trigger.id ? (
                          <ConfirmInline label="Confirm" onConfirm={() => void remove(trigger.id)} onCancel={() => setPendingDelete(null)} />
                        ) : (
                          <IconButton label={`Delete ${trigger.name}`} onClick={() => setPendingDelete(trigger.id)} className="hover:bg-status-error/20 hover:text-status-error">
                            <Trash2 size={14} />
                          </IconButton>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-bg-raised">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="space-y-3 text-sm">
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Webhook URL</p>
                              <div className="flex items-center gap-2 font-mono text-xs bg-bg-primary border border-border-subtle rounded-sm px-2 py-1.5">
                                <span className="flex-1 break-all text-text-primary">{webhookUrl}</span>
                                <CopyButton text={webhookUrl} label="Copy webhook URL" />
                              </div>
                            </div>
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Secret</p>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 flex items-center gap-2 font-mono text-xs bg-bg-primary border border-border-subtle rounded-sm px-2 py-1.5">
                                  <span className="flex-1 text-text-secondary">{revealedSecret ?? '••••••••••••••••••••••••••••••••'}</span>
                                  {revealedSecret && <CopyButton text={revealedSecret} label="Copy secret" />}
                                </div>
                                {pendingRegen === trigger.id ? (
                                  <ConfirmInline label="Confirm regen" onConfirm={() => void regenerate(trigger.id)} onCancel={() => setPendingRegen(null)} />
                                ) : (
                                  <button onClick={() => setPendingRegen(trigger.id)} className="flex items-center gap-1 px-2 py-1.5 rounded-sm border border-border-subtle text-xs text-text-secondary hover:bg-bg-raised hover:text-text-primary transition-colors">
                                    <RefreshCw size={12} />{revealedSecret ? 'Regenerate' : 'Reveal / Regenerate'}
                                  </button>
                                )}
                              </div>
                            </div>
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Example curl</p>
                              <div className="relative">
                                <pre className="font-mono text-xs bg-bg-primary border border-border-subtle rounded-sm px-3 py-2 overflow-x-auto text-text-secondary whitespace-pre">{curl}</pre>
                                <div className="absolute top-1.5 right-1.5"><CopyButton text={curl} label="Copy curl example" /></div>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function NewTriggerForm({ agents, onCancel, onCreated }: { agents: Array<{ id: string; name: string }>; onCancel: () => void; onCreated: (t: WebhookTrigger) => void }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      onCreated(await apiFetch<WebhookTrigger>('/api/webhook-triggers', { method: 'POST', body: form }))
    } catch (err) {
      setError(errorMessage(err, 'Failed'))
    } finally {
      setCreating(false)
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-accent/40 bg-bg-raised p-4 space-y-3">
      <h2 className="text-sm font-semibold text-text-primary">New Webhook Trigger</h2>
      {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Name</span><Input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="px-2 py-1.5 bg-bg-primary" placeholder="My GitHub Webhook" /></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Agent</span><Select required value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))} className="px-2 py-1.5 bg-bg-primary"><option value="">Select agent…</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Source</span><Select value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} className="px-2 py-1.5 bg-bg-primary">{SOURCE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></label>
        <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Task Title Template <span className="opacity-70">({SOURCE_VARS[form.source]})</span></span><Input required value={form.taskTitle} onChange={e => setForm(f => ({ ...f, taskTitle: e.target.value }))} className="px-2 py-1.5 bg-bg-primary" placeholder="Push to {{repo}}/{{branch}}" /></label>
      </div>
      <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Task Description Template (optional)</span><Textarea rows={2} value={form.taskDesc} onChange={e => setForm(f => ({ ...f, taskDesc: e.target.value }))} className="px-2 py-1.5 bg-bg-primary" /></label>
      <div className="flex gap-2">
        <button type="submit" disabled={creating} className="px-3 py-1.5 rounded-sm bg-accent text-bg-primary text-sm font-medium hover:bg-accent/90 disabled:opacity-50">{creating ? 'Creating…' : 'Create'}</button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-sm border border-border-subtle text-sm text-text-secondary hover:bg-bg-raised">Cancel</button>
      </div>
    </form>
  )
}
