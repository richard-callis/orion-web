'use client'
import { useState, useEffect } from 'react'
import { Bell, Plus, Trash2, Send, X } from 'lucide-react'

type Channel = {
  id: string
  name: string
  type: string
  webhookUrl: string
  events: string
  agentFilter: string | null
  enabled: boolean
  createdAt: string
}

const EVENT_OPTIONS = [
  { value: 'task_completed',       label: 'Task Completed' },
  { value: 'task_failed',          label: 'Task Failed' },
  { value: 'budget_exceeded',      label: 'Budget Exceeded' },
  { value: 'plan_approval_needed', label: 'Plan Approval Needed' },
]

const TYPE_LABELS: Record<string, string> = {
  slack:   'Slack',
  discord: 'Discord',
  webhook: 'Custom Webhook',
}

const TYPE_BADGE: Record<string, string> = {
  slack:   'bg-purple-500/20 text-purple-300',
  discord: 'bg-indigo-500/20 text-indigo-300',
  webhook: 'bg-zinc-500/20 text-zinc-300',
}

export default function NotificationChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'loading' | 'ok' | 'error'>>({})
  const [testError, setTestError] = useState<Record<string, string>>({})

  // Form state
  const [name, setName] = useState('')
  const [type, setType] = useState('slack')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['task_completed', 'task_failed'])
  const [saving, setSaving] = useState(false)

  async function load() {
    const res = await fetch('/api/notification-channels')
    if (res.ok) setChannels(await res.json())
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !webhookUrl.trim()) return
    setSaving(true)
    await fetch('/api/notification-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        type,
        webhookUrl: webhookUrl.trim(),
        events: JSON.stringify(selectedEvents),
      }),
    })
    setName('')
    setWebhookUrl('')
    setSelectedEvents(['task_completed', 'task_failed'])
    setType('slack')
    setShowForm(false)
    setSaving(false)
    await load()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this notification channel?')) return
    await fetch(`/api/notification-channels/${id}`, { method: 'DELETE' })
    await load()
  }

  async function handleToggle(channel: Channel) {
    await fetch(`/api/notification-channels/${channel.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !channel.enabled }),
    })
    await load()
  }

  async function handleTest(id: string) {
    setTestStatus(s => ({ ...s, [id]: 'loading' }))
    setTestError(s => ({ ...s, [id]: '' }))
    const res = await fetch(`/api/notification-channels/${id}/test`, { method: 'POST' })
    const data = await res.json() as { ok: boolean; error?: string }
    setTestStatus(s => ({ ...s, [id]: data.ok ? 'ok' : 'error' }))
    if (!data.ok) setTestError(s => ({ ...s, [id]: data.error ?? 'Unknown error' }))
    setTimeout(() => setTestStatus(s => ({ ...s, [id]: 'idle' })), 4000)
  }

  function toggleEvent(val: string) {
    setSelectedEvents(prev =>
      prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val]
    )
  }

  return (
    <div className="p-4 lg:p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bell size={20} className="text-accent" />
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Notification Channels</h1>
            <p className="text-sm text-text-muted">Send Slack, Discord, or webhook alerts on task events.</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-2 px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/90 transition-colors"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'New Channel'}
        </button>
      </div>

      {/* New channel form */}
      {showForm && (
        <form onSubmit={handleCreate} className="rounded-lg border border-border-subtle bg-bg-raised p-4 space-y-4">
          <h2 className="text-sm font-medium text-text-primary">New Notification Channel</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. #alerts-channel"
                required
                className="w-full px-3 py-1.5 text-sm rounded border border-border-subtle bg-bg-base text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value)}
                className="w-full px-3 py-1.5 text-sm rounded border border-border-subtle bg-bg-base text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="webhook">Custom Webhook</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Webhook URL</label>
            <input
              value={webhookUrl}
              onChange={e => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/..."
              required
              type="url"
              className="w-full px-3 py-1.5 text-sm rounded border border-border-subtle bg-bg-base text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Events to subscribe</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {EVENT_OPTIONS.map(opt => (
                <label key={opt.value} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(opt.value)}
                    onChange={() => toggleEvent(opt.value)}
                    className="rounded"
                  />
                  <span className="text-text-secondary">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Create Channel'}
            </button>
          </div>
        </form>
      )}

      {/* Channels list */}
      {loading ? (
        <p className="text-sm text-text-muted">Loading...</p>
      ) : channels.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <Bell size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No notification channels configured.</p>
          <p className="text-xs mt-1">Create one above to start receiving alerts.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-raised border-b border-border-subtle">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Name</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Type</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Events</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Enabled</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {channels.map(ch => {
                let evts: string[] = []
                try { evts = JSON.parse(ch.events) } catch {}
                return (
                  <tr key={ch.id} className="hover:bg-bg-raised">
                    <td className="px-3 py-2 font-medium text-text-primary">{ch.name}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_BADGE[ch.type] ?? TYPE_BADGE.webhook}`}>
                        {TYPE_LABELS[ch.type] ?? ch.type}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {evts.map(e => (
                          <span key={e} className="px-1.5 py-0.5 rounded text-xs bg-bg-raised border border-border-subtle text-text-secondary">
                            {e.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => handleToggle(ch)}
                        className={`relative inline-flex h-5 w-9 rounded-full transition-colors focus:outline-none ${ch.enabled ? 'bg-accent' : 'bg-zinc-600'}`}
                        title={ch.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                      >
                        <span className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transition-transform ${ch.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleTest(ch.id)}
                          disabled={testStatus[ch.id] === 'loading'}
                          title="Send test notification"
                          className={`p-1.5 rounded hover:bg-bg-raised transition-colors ${testStatus[ch.id] === 'ok' ? 'text-green-400' : testStatus[ch.id] === 'error' ? 'text-red-400' : 'text-text-muted hover:text-text-primary'}`}
                        >
                          <Send size={14} />
                        </button>
                        {testError[ch.id] && (
                          <span className="text-xs text-red-400" title={testError[ch.id]}>!</span>
                        )}
                        <button
                          onClick={() => handleDelete(ch.id)}
                          title="Delete channel"
                          className="p-1.5 rounded text-text-muted hover:text-red-400 hover:bg-bg-raised transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
