'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import {
  Plus, Trash2, Play, Clock, Check, X,
  Webhook, RefreshCw, Copy, ChevronDown, ChevronUp,
  Zap, Activity, Settings, CalendarClock,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Agent = { id: string; name: string }
type Tab = 'schedules' | 'webhooks' | 'system' | 'history'

interface ScheduledTask {
  id: string
  name: string
  description?: string | null
  agentId: string
  agent: Agent
  cronExpr: string
  taskTitle: string
  taskDesc?: string | null
  enabled: boolean
  lastRunAt?: string | null
  nextRunAt?: string | null
  lastTaskId?: string | null
  createdAt: string
  updatedAt: string
}

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
  secret?: string
}

interface JobRun {
  id: string
  source: string
  sourceId: string
  sourceName: string
  agentId: string | null
  taskId: string | null
  status: string
  startedAt: string
  finishedAt: string | null
  errorMessage: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: string | null | undefined) {
  if (!d) return '—'
  try { return new Date(d).toLocaleString() } catch { return d }
}

function duration(start: string, end: string | null) {
  if (!end) return 'running…'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

// ── Webhook helpers ───────────────────────────────────────────────────────────

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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="p-1 rounded hover:bg-bg-raised text-text-muted hover:text-text-primary transition-colors"
      title="Copy"
    >
      {copied ? <Check size={14} className="text-status-healthy" /> : <Copy size={14} />}
    </button>
  )
}

// ── System jobs catalogue ─────────────────────────────────────────────────────

const SYSTEM_JOBS = [
  { key: 'gitops-drift',       name: 'GitOps Drift Detection',  desc: 'Compares cluster state to desired GitOps state',        cadence: 'Every 5 min' },
  { key: 'goal-heartbeat',     name: 'Goal Heartbeat',           desc: 'Re-triggers agents in rooms with stale goals',          cadence: 'Every 5 min' },
  { key: 'security-correlator',name: 'Security Correlator',      desc: 'Correlates security events across sources',             cadence: 'Continuous' },
  { key: 'k8s-poller',         name: 'K8s Security Poller',      desc: 'Polls Kubernetes for security events',                  cadence: 'Periodic' },
  { key: 'elk-poller',         name: 'ELK Security Poller',      desc: 'Polls Elasticsearch/Kibana for alerts',                 cadence: 'Periodic' },
  { key: 'ntopng-poller',      name: 'ntopng Network Poller',    desc: 'Polls ntopng for network anomalies',                    cadence: 'Periodic' },
  { key: 'vuln-scan-daily',    name: 'Daily Vuln Scanner',       desc: 'Scans for new CVEs and vulnerabilities',                cadence: 'Daily at 02:00' },
  { key: 'crowdsec-sync',      name: 'CrowdSec Sync',            desc: 'Syncs CrowdSec ban decisions',                         cadence: 'Periodic' },
  { key: 'audit-export',       name: 'Audit Export',             desc: 'Exports audit logs for compliance',                    cadence: 'Daily' },
  { key: 'retention',          name: 'Data Retention',           desc: 'Purges old data per retention policy',                 cadence: 'Daily' },
]

// ── Cron builder ──────────────────────────────────────────────────────────────

type FreqType = 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function buildCron(freq: FreqType, every: number, minute: number, hour: number, weekday: number, monthDay: number): string {
  switch (freq) {
    case 'minutely': return every <= 1 ? '* * * * *' : `*/${every} * * * *`
    case 'hourly':   return every <= 1 ? `${minute} * * * *` : `${minute} */${every} * * *`
    case 'daily':    return `${minute} ${hour} * * *`
    case 'weekly':   return `${minute} ${hour} * * ${weekday}`
    case 'monthly':  return `${minute} ${hour} ${monthDay} * *`
    default:         return ''
  }
}

function describeCron(freq: FreqType, every: number, minute: number, hour: number, weekday: number, monthDay: number): string {
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  switch (freq) {
    case 'minutely': return every <= 1 ? 'Every minute' : `Every ${every} minutes`
    case 'hourly':   return every <= 1 ? `Every hour at :${String(minute).padStart(2, '0')}` : `Every ${every} hours at :${String(minute).padStart(2, '0')}`
    case 'daily':    return `Daily at ${hhmm}`
    case 'weekly':   return `Every ${DAYS[weekday]} at ${hhmm}`
    case 'monthly':  return `Monthly on day ${monthDay} at ${hhmm}`
    default:         return ''
  }
}

function CronBuilder({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const [advanced, setAdvanced] = useState(false)
  const [freq, setFreq]         = useState<FreqType>('daily')
  const [every, setEvery]       = useState(1)
  const [minute, setMinute]     = useState(0)
  const [hour, setHour]         = useState(9)
  const [weekday, setWeekday]   = useState(1)
  const [monthDay, setMonthDay] = useState(1)

  const generatedCron = buildCron(freq, every, minute, hour, weekday, monthDay)
  const humanLabel    = describeCron(freq, every, minute, hour, weekday, monthDay)

  useEffect(() => {
    if (!advanced) onChange(generatedCron)
  }, [advanced, generatedCron]) // eslint-disable-line react-hooks/exhaustive-deps

  const sel = 'px-2 py-1.5 text-sm bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent'
  const num = sel + ' w-16 text-center'

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs text-text-secondary">Schedule</label>
        <button
          type="button"
          onClick={() => { setAdvanced(a => !a); if (!advanced) onChange(generatedCron) }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-accent transition-colors"
        >
          <Settings size={11} />
          {advanced ? 'Simple mode' : 'Advanced (cron)'}
        </button>
      </div>

      {advanced ? (
        <input
          className="w-full px-3 py-1.5 text-sm bg-bg-base border border-border-subtle rounded text-text-primary font-mono focus:outline-none focus:border-accent"
          placeholder="0 9 * * 1"
          value={value}
          onChange={e => onChange(e.target.value)}
          required
        />
      ) : (
        <div className="space-y-3 p-3 bg-bg-base border border-border-subtle rounded-lg">
          {/* Frequency selector */}
          <div className="flex flex-wrap gap-1">
            {(['minutely','hourly','daily','weekly','monthly'] as FreqType[]).map(f => (
              <button
                key={f}
                type="button"
                onClick={() => setFreq(f)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${freq === f ? 'bg-accent text-white' : 'bg-bg-raised text-text-secondary hover:text-text-primary'}`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Context-sensitive controls */}
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            {freq === 'minutely' && (
              <>
                <span>Every</span>
                <input type="number" min={1} max={59} value={every} onChange={e => setEvery(+e.target.value)} className={num} />
                <span>minute{every !== 1 ? 's' : ''}</span>
              </>
            )}
            {freq === 'hourly' && (
              <>
                <span>Every</span>
                <input type="number" min={1} max={23} value={every} onChange={e => setEvery(+e.target.value)} className={num} />
                <span>hour{every !== 1 ? 's' : ''} at minute</span>
                <input type="number" min={0} max={59} value={minute} onChange={e => setMinute(+e.target.value)} className={num} />
              </>
            )}
            {(freq === 'daily' || freq === 'weekly' || freq === 'monthly') && (
              <>
                {freq === 'weekly' && (
                  <>
                    <span>Every</span>
                    <select value={weekday} onChange={e => setWeekday(+e.target.value)} className={sel}>
                      {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                    </select>
                  </>
                )}
                {freq === 'monthly' && (
                  <>
                    <span>On day</span>
                    <input type="number" min={1} max={28} value={monthDay} onChange={e => setMonthDay(+e.target.value)} className={num} />
                  </>
                )}
                <span>at</span>
                <input type="number" min={0} max={23} value={hour} onChange={e => setHour(+e.target.value)} className={num} />
                <span>:</span>
                <input type="number" min={0} max={59} value={minute} onChange={e => setMinute(+e.target.value)} className={num} />
              </>
            )}
          </div>

          {/* Human-readable summary + generated cron */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-primary font-medium">{humanLabel}</span>
            <span className="font-mono text-text-muted">{generatedCron}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Schedules tab ─────────────────────────────────────────────────────────────

function SchedulesTab() {
  const [schedules, setSchedules] = useState<ScheduledTask[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [triggering, setTriggering] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', agentId: '', cronExpr: '0 9 * * *', taskTitle: '', taskDesc: '', enabled: true })

  const load = useCallback(async () => {
    try {
      const [sr, ar] = await Promise.all([fetch('/api/scheduled-tasks'), fetch('/api/agents')])
      if (sr.ok) setSchedules(await sr.json())
      if (ar.ok) { const d = await ar.json(); setAgents(Array.isArray(d) ? d : (d.agents ?? [])) }
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setFormError(null)
    try {
      const res = await fetch('/api/scheduled-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.name, agentId: form.agentId, cronExpr: form.cronExpr, taskTitle: form.taskTitle, taskDesc: form.taskDesc || undefined, enabled: form.enabled }) })
      if (!res.ok) { const d = await res.json(); setFormError(d.error ?? 'Failed'); return }
      setShowForm(false); setForm({ name: '', agentId: '', cronExpr: '0 9 * * *', taskTitle: '', taskDesc: '', enabled: true }); await load()
    } catch (e) { setFormError(e instanceof Error ? e.message : 'Request failed') }
  }

  async function handleToggle(s: ScheduledTask) {
    setToggling(s.id)
    await fetch(`/api/scheduled-tasks/${s.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) })
    await load(); setToggling(null)
  }

  async function handleTrigger(id: string) {
    setTriggering(id)
    const res = await fetch(`/api/scheduled-tasks/${id}/trigger`, { method: 'POST' })
    if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Failed to trigger') }
    else await load()
    setTriggering(null)
  }

  async function handleDelete(id: string) {
    if (pendingDelete !== id) { setPendingDelete(id); return }
    setPendingDelete(null)
    setDeleting(id); await fetch(`/api/scheduled-tasks/${id}`, { method: 'DELETE' }); await load(); setDeleting(null)
  }

  const inp = 'w-full px-3 py-1.5 text-sm bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">{schedules.length} schedule{schedules.length !== 1 ? 's' : ''}</p>
        <button onClick={() => setShowForm(v => !v)} className="flex items-center gap-2 px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/80 transition-colors">
          <Plus size={15} /> New Schedule
        </button>
      </div>

      {error && <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400 flex items-center justify-between">{error}<button onClick={() => setError(null)}><X size={14} /></button></div>}

      {showForm && (
        <div className="p-4 bg-bg-raised border border-border-subtle rounded-lg">
          <h2 className="text-sm font-semibold text-text-primary mb-4">New Scheduled Task</h2>
          <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div><label className="block text-xs text-text-secondary mb-1">Schedule Name</label><input className={inp} placeholder="e.g. Daily health check" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required /></div>
            <div><label className="block text-xs text-text-secondary mb-1">Agent</label><select className={inp} value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))} required><option value="">Select agent...</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
            <div className="md:col-span-2"><CronBuilder value={form.cronExpr} onChange={cronExpr => setForm(f => ({ ...f, cronExpr }))} /></div>
            <div><label className="block text-xs text-text-secondary mb-1">Task Title</label><input className={inp} placeholder="Title for each spawned task" value={form.taskTitle} onChange={e => setForm(f => ({ ...f, taskTitle: e.target.value }))} required /></div>
            <div className="md:col-span-2"><label className="block text-xs text-text-secondary mb-1">Task Description (optional)</label><textarea className={inp + ' resize-none'} rows={2} value={form.taskDesc} onChange={e => setForm(f => ({ ...f, taskDesc: e.target.value }))} /></div>
            <div className="md:col-span-2 flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer"><input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="accent-accent" />Enabled</label>
              {formError && <span className="text-xs text-red-400">{formError}</span>}
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={() => { setShowForm(false); setFormError(null) }} className="px-3 py-1.5 text-sm border border-border-subtle rounded text-text-secondary hover:bg-bg-raised">Cancel</button>
                <button type="submit" className="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/80">Create</button>
              </div>
            </div>
          </form>
        </div>
      )}

      {loading ? <div className="text-sm text-text-secondary">Loading...</div> : schedules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <CalendarClock size={32} className="text-text-muted/40" />
          <p className="text-sm font-medium text-text-secondary">No scheduled tasks yet</p>
          <p className="text-xs text-text-muted max-w-xs">Schedule recurring tasks using cron expressions. Click <strong>+ New Schedule</strong> to get started.</p>
        </div>
      ) : (
        <div className="border border-border-subtle rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-bg-raised border-b border-border-subtle">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Name</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Agent</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Cron</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Next Run</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Last Run</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Enabled</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-border-subtle">
              {schedules.map(s => (
                <tr key={s.id} className="hover:bg-bg-raised/50 transition-colors">
                  <td className="px-4 py-3"><div className="font-medium text-text-primary">{s.name}</div><div className="text-xs text-text-muted mt-0.5">{s.taskTitle}</div></td>
                  <td className="px-4 py-3 text-text-secondary">{s.agent.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">{s.cronExpr}</td>
                  <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap"><span className="flex items-center gap-1"><Clock size={11} />{formatDate(s.nextRunAt)}</span></td>
                  <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap">{formatDate(s.lastRunAt)}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => handleToggle(s)} disabled={toggling === s.id} className={`w-8 h-5 rounded-full transition-colors flex items-center justify-center ${s.enabled ? 'bg-green-500/80 hover:bg-green-500' : 'bg-bg-raised border border-border-subtle'}`}>
                      {s.enabled ? <Check size={11} className="text-white" /> : <X size={11} className="text-text-muted" />}
                    </button>
                  </td>
                  <td className="px-4 py-3"><div className="flex items-center gap-2">
                    <button onClick={() => handleTrigger(s.id)} disabled={triggering === s.id} title="Trigger now" className="p-1.5 text-text-secondary hover:text-accent hover:bg-accent/10 rounded transition-colors"><Play size={13} /></button>
                    {pendingDelete === s.id ? (
                      <>
                        <button onClick={() => handleDelete(s.id)} disabled={deleting === s.id} className="px-2 py-1 text-xs text-white bg-red-500 rounded hover:bg-red-600 transition-colors">Confirm</button>
                        <button onClick={() => setPendingDelete(null)} className="px-2 py-1 text-xs text-text-secondary border border-border-subtle rounded hover:bg-bg-raised transition-colors">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => handleDelete(s.id)} disabled={deleting === s.id} title="Delete" className="p-1.5 text-text-secondary hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"><Trash2 size={13} /></button>
                    )}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Webhooks tab ──────────────────────────────────────────────────────────────

function WebhooksTab() {
  const [triggers, setTriggers] = useState<WebhookTrigger[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({})
  const [form, setForm] = useState({ name: '', agentId: '', source: 'custom', taskTitle: '', taskDesc: '' })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [pendingDeleteWebhook, setPendingDeleteWebhook] = useState<string | null>(null)
  const [pendingRegen, setPendingRegen] = useState<string | null>(null)

  const loadTriggers = useCallback(async () => {
    const res = await fetch('/api/webhook-triggers')
    if (res.ok) setTriggers(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => {
    loadTriggers()
    fetch('/api/agents').then(r => r.json()).then(d => setAgents(Array.isArray(d) ? d : (d.agents ?? [])))
  }, [loadTriggers])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setCreating(true); setCreateError(null)
    try {
      const res = await fetch('/api/webhook-triggers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      if (!res.ok) { const err = await res.json(); setCreateError(err.error ?? 'Failed'); return }
      const created: WebhookTrigger = await res.json()
      setTriggers(prev => [created, ...prev])
      if (created.secret) setRevealedSecrets(prev => ({ ...prev, [created.id]: created.secret! }))
      setExpandedId(created.id); setShowForm(false); setForm({ name: '', agentId: '', source: 'custom', taskTitle: '', taskDesc: '' })
    } finally { setCreating(false) }
  }

  async function handleDelete(id: string) {
    if (pendingDeleteWebhook !== id) { setPendingDeleteWebhook(id); return }
    setPendingDeleteWebhook(null)
    await fetch(`/api/webhook-triggers/${id}`, { method: 'DELETE' })
    setTriggers(prev => prev.filter(t => t.id !== id))
  }

  async function handleToggle(trigger: WebhookTrigger) {
    const res = await fetch(`/api/webhook-triggers/${trigger.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !trigger.enabled }) })
    if (res.ok) { const u: WebhookTrigger = await res.json(); setTriggers(prev => prev.map(t => t.id === u.id ? { ...t, enabled: u.enabled } : t)) }
  }

  async function handleRegenSecret(id: string) {
    if (pendingRegen !== id) { setPendingRegen(id); return }
    setPendingRegen(null)
    const res = await fetch(`/api/webhook-triggers/${id}/regenerate-secret`, { method: 'POST' })
    if (res.ok) { const { secret } = await res.json(); setRevealedSecrets(prev => ({ ...prev, [id]: secret })) }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const inp = 'px-2 py-1.5 rounded bg-bg-primary border border-border-subtle text-sm text-text-primary focus:outline-none focus:border-accent'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">{triggers.length} trigger{triggers.length !== 1 ? 's' : ''} configured</p>
        <button onClick={() => setShowForm(f => !f)} className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-bg-primary text-sm font-medium hover:bg-accent/90 transition-colors">
          <Plus size={15} /> New Trigger
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-lg border border-accent/40 bg-bg-raised p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text-primary">New Webhook Trigger</h2>
          {createError && <p className="text-xs text-status-error">{createError}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Name</span><input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inp + ' w-full'} placeholder="My GitHub Webhook" /></label>
            <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Agent</span><select required value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))} className={inp + ' w-full'}><option value="">Select agent…</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Source</span><select value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} className={inp + ' w-full'}>{SOURCE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
            <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Task Title Template <span className="opacity-70">({SOURCE_VARS[form.source]})</span></span><input required value={form.taskTitle} onChange={e => setForm(f => ({ ...f, taskTitle: e.target.value }))} className={inp + ' w-full'} placeholder="Push to {{repo}}/{{branch}}" /></label>
          </div>
          <label className="flex flex-col gap-1"><span className="text-xs text-text-muted">Task Description Template (optional)</span><textarea rows={2} value={form.taskDesc} onChange={e => setForm(f => ({ ...f, taskDesc: e.target.value }))} className={inp + ' w-full resize-none'} /></label>
          <div className="flex gap-2">
            <button type="submit" disabled={creating} className="px-3 py-1.5 rounded bg-accent text-bg-primary text-sm font-medium hover:bg-accent/90 disabled:opacity-50">{creating ? 'Creating…' : 'Create'}</button>
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-1.5 rounded border border-border-subtle text-sm text-text-secondary hover:bg-bg-raised">Cancel</button>
          </div>
        </form>
      )}

      {loading ? <p className="text-sm text-text-muted">Loading…</p> : triggers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <Webhook size={32} className="text-text-muted/40" />
          <p className="text-sm font-medium text-text-secondary">No webhook triggers yet</p>
          <p className="text-xs text-text-muted max-w-xs">Connect external systems to kick off agents automatically. Click <strong>+ New Trigger</strong> to create one.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-raised border-b border-border-subtle"><tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Name</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Source</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Agent</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Last Fired</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Fires</th>
              <th className="px-3 py-2 text-center text-xs font-medium text-text-muted">Enabled</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-text-muted">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-border-subtle">
              {triggers.map(trigger => {
                const expanded = expandedId === trigger.id
                const webhookUrl = `${origin}/api/webhooks/${trigger.id}`
                const revealedSecret = revealedSecrets[trigger.id]
                return (
                  <>
                    <tr key={trigger.id} className="hover:bg-bg-raised cursor-pointer" onClick={() => setExpandedId(expanded ? null : trigger.id)}>
                      <td className="px-3 py-2.5 font-medium text-text-primary flex items-center gap-1.5">
                        {expanded ? <ChevronUp size={14} className="text-text-muted flex-shrink-0" /> : <ChevronDown size={14} className="text-text-muted flex-shrink-0" />}
                        {trigger.name}
                      </td>
                      <td className="px-3 py-2.5"><span className={`px-1.5 py-0.5 rounded text-xs font-medium ${sourceBadgeCls(trigger.source)}`}>{trigger.source}</span></td>
                      <td className="px-3 py-2.5 text-text-secondary">{trigger.agent?.name ?? '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-text-muted">{trigger.lastFiredAt ? new Date(trigger.lastFiredAt).toLocaleString() : '—'}</td>
                      <td className="px-3 py-2.5 text-xs font-mono text-text-muted">{trigger.fireCount}</td>
                      <td className="px-3 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                        <button onClick={() => handleToggle(trigger)} className={`w-8 h-4 rounded-full transition-colors relative ${trigger.enabled ? 'bg-accent' : 'bg-bg-raised border border-border-subtle'}`}>
                          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${trigger.enabled ? 'right-0.5' : 'left-0.5'}`} />
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                        {pendingDeleteWebhook === trigger.id ? (
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => handleDelete(trigger.id)} className="px-2 py-1 text-xs text-white bg-red-500 rounded hover:bg-red-600 transition-colors">Confirm</button>
                            <button onClick={() => setPendingDeleteWebhook(null)} className="px-2 py-1 text-xs text-text-secondary border border-border-subtle rounded hover:bg-bg-raised transition-colors">Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => handleDelete(trigger.id)} className="p-1 rounded hover:bg-status-error/20 text-text-muted hover:text-status-error transition-colors"><Trash2 size={14} /></button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={`${trigger.id}-detail`} className="bg-bg-raised">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="space-y-3 text-sm">
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Webhook URL</p>
                              <div className="flex items-center gap-2 font-mono text-xs bg-bg-primary border border-border-subtle rounded px-2 py-1.5">
                                <span className="flex-1 break-all text-text-primary">{webhookUrl}</span>
                                <CopyButton text={webhookUrl} />
                              </div>
                            </div>
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Secret</p>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 flex items-center gap-2 font-mono text-xs bg-bg-primary border border-border-subtle rounded px-2 py-1.5">
                                  <span className="flex-1 text-text-secondary">{revealedSecret ?? '••••••••••••••••••••••••••••••••'}</span>
                                  {revealedSecret && <CopyButton text={revealedSecret} />}
                                </div>
                                {pendingRegen === trigger.id ? (
                                  <div className="flex items-center gap-1">
                                    <button onClick={() => handleRegenSecret(trigger.id)} className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-white bg-red-500 hover:bg-red-600 transition-colors">Confirm regen</button>
                                    <button onClick={() => setPendingRegen(null)} className="px-2 py-1.5 rounded border border-border-subtle text-xs text-text-secondary hover:bg-bg-raised transition-colors">Cancel</button>
                                  </div>
                                ) : (
                                  <button onClick={() => handleRegenSecret(trigger.id)} className="flex items-center gap-1 px-2 py-1.5 rounded border border-border-subtle text-xs text-text-secondary hover:bg-bg-raised hover:text-text-primary transition-colors">
                                    <RefreshCw size={12} />{revealedSecret ? 'Regenerate' : 'Reveal / Regenerate'}
                                  </button>
                                )}
                              </div>
                            </div>
                            <div>
                              <p className="text-xs text-text-muted mb-1 font-medium">Example curl</p>
                              <div className="relative">
                                <pre className="font-mono text-xs bg-bg-primary border border-border-subtle rounded px-3 py-2 overflow-x-auto text-text-secondary whitespace-pre">{SOURCE_CURL[trigger.source]?.(webhookUrl, revealedSecret ?? '<your-secret>') ?? ''}</pre>
                                <div className="absolute top-1.5 right-1.5"><CopyButton text={SOURCE_CURL[trigger.source]?.(webhookUrl, revealedSecret ?? '<your-secret>') ?? ''} /></div>
                              </div>
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

// ── System tab ────────────────────────────────────────────────────────────────

function SystemTab() {
  const [lastRuns, setLastRuns] = useState<Record<string, JobRun>>({})

  useEffect(() => {
    fetch('/api/job-runs?source=system&limit=100')
      .then(r => r.ok ? r.json() : [])
      .then((runs: JobRun[]) => {
        const map: Record<string, JobRun> = {}
        for (const run of runs) {
          if (!map[run.sourceId]) map[run.sourceId] = run
        }
        setLastRuns(map)
      })
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">System background jobs run automatically by the ORION worker. Runs appear in the History tab.</p>
      <div className="border border-border-subtle rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised border-b border-border-subtle"><tr>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Job</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Description</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Cadence</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Last Run</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Last Status</th>
          </tr></thead>
          <tbody className="divide-y divide-border-subtle">
            {SYSTEM_JOBS.map(job => {
              const last = lastRuns[job.key]
              return (
                <tr key={job.key} className="hover:bg-bg-raised/50">
                  <td className="px-4 py-3 font-medium text-text-primary whitespace-nowrap">{job.name}</td>
                  <td className="px-4 py-3 text-xs text-text-secondary">{job.desc}</td>
                  <td className="px-4 py-3 text-xs font-mono text-text-muted whitespace-nowrap">{job.cadence}</td>
                  <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap">{last ? formatDate(last.startedAt) : '—'}</td>
                  <td className="px-4 py-3">{last ? <StatusBadge status={last.status} /> : <span className="text-xs text-text-muted">—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── History tab ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'completed' ? 'bg-green-500/20 text-green-400'
    : status === 'failed' ? 'bg-red-500/20 text-red-400'
    : 'bg-yellow-500/20 text-yellow-400'
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{status}</span>
}

function SourceBadge({ source }: { source: string }) {
  const cls = source === 'schedule' ? 'bg-blue-500/20 text-blue-400'
    : source === 'webhook' ? 'bg-purple-500/20 text-purple-400'
    : 'bg-gray-500/20 text-gray-400'
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{source}</span>
}

function HistoryTab() {
  const [runs, setRuns] = useState<JobRun[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/job-runs?limit=200')
      .then(r => r.ok ? r.json() : [])
      .then(data => { setRuns(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-sm text-text-muted p-4">Loading…</div>
  if (!runs.length) return <div className="text-sm text-text-muted py-12 text-center">No job runs recorded yet. Runs will appear here after a schedule, webhook, or system job fires.</div>

  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg-raised border-b border-border-subtle"><tr>
          <th className="px-3 py-2.5 text-left text-xs font-medium text-text-secondary">Time</th>
          <th className="px-3 py-2.5 text-left text-xs font-medium text-text-secondary">Source</th>
          <th className="px-3 py-2.5 text-left text-xs font-medium text-text-secondary">Job</th>
          <th className="px-3 py-2.5 text-left text-xs font-medium text-text-secondary">Agent</th>
          <th className="px-3 py-2.5 text-left text-xs font-medium text-text-secondary">Status</th>
          <th className="px-3 py-2.5 text-left text-xs font-medium text-text-secondary">Duration</th>
        </tr></thead>
        <tbody className="divide-y divide-border-subtle">
          {runs.map(run => (
            <tr key={run.id} className="hover:bg-bg-raised/50">
              <td className="px-3 py-2.5 text-xs font-mono text-text-muted whitespace-nowrap">{formatDate(run.startedAt)}</td>
              <td className="px-3 py-2.5"><SourceBadge source={run.source} /></td>
              <td className="px-3 py-2.5 text-sm text-text-primary">{run.sourceName}</td>
              <td className="px-3 py-2.5 text-xs text-text-secondary font-mono">{run.agentId ? run.agentId.slice(0, 8) + '…' : '—'}</td>
              <td className="px-3 py-2.5"><StatusBadge status={run.status} />{run.errorMessage && <p className="text-xs text-red-400 mt-0.5 truncate max-w-[200px]" title={run.errorMessage}>{run.errorMessage}</p>}</td>
              <td className="px-3 py-2.5 text-xs font-mono text-text-muted">{duration(run.startedAt, run.finishedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main Jobs page ────────────────────────────────────────────────────────────

function JobsPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const activeTab = (searchParams.get('tab') ?? 'schedules') as Tab

  const setTab = (t: Tab) => router.push(`/jobs?tab=${t}`, { scroll: false })

  const tabCls = (t: Tab) =>
    `px-3 py-1.5 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
      activeTab === t
        ? 'bg-accent/10 text-accent border border-accent/30'
        : 'text-text-muted hover:text-text-primary hover:bg-bg-raised'
    }`

  const TABS: { key: Tab; label: string }[] = [
    { key: 'schedules', label: 'Schedules' },
    { key: 'webhooks',  label: 'Webhooks' },
    { key: 'system',    label: 'System' },
    { key: 'history',   label: 'History' },
  ]

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Zap size={20} className="text-accent" />
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Jobs</h1>
          <p className="text-sm text-text-muted mt-0.5">Schedules, webhooks, and system background jobs</p>
        </div>
      </div>
      <div className="flex gap-1 flex-wrap border-b border-border-subtle pb-2">
        {TABS.map(t => (
          <button key={t.key} className={tabCls(t.key)} onClick={() => setTab(t.key)}>
            {t.key === 'history' ? <Activity size={11} className="inline mr-1" /> : null}
            {t.label}
          </button>
        ))}
      </div>
      <div>
        {activeTab === 'schedules' && <SchedulesTab />}
        {activeTab === 'webhooks'  && <WebhooksTab />}
        {activeTab === 'system'    && <SystemTab />}
        {activeTab === 'history'   && <HistoryTab />}
      </div>
    </div>
  )
}

export function JobsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-text-muted">Loading…</div>}>
      <JobsPageInner />
    </Suspense>
  )
}
