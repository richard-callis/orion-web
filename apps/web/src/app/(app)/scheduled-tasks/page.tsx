'use client'
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Play, Clock, Check, X } from 'lucide-react'

interface Agent {
  id: string
  name: string
}

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

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr).toLocaleString()
  } catch {
    return dateStr
  }
}

export default function ScheduledTasksPage() {
  const [schedules, setSchedules] = useState<ScheduledTask[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [triggering, setTriggering] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '',
    agentId: '',
    cronExpr: '',
    taskTitle: '',
    taskDesc: '',
    enabled: true,
  })

  const load = useCallback(async () => {
    try {
      const [schedulesRes, agentsRes] = await Promise.all([
        fetch('/api/scheduled-tasks'),
        fetch('/api/agents'),
      ])
      if (schedulesRes.ok) setSchedules(await schedulesRes.json())
      if (agentsRes.ok) {
        const agentsData = await agentsRes.json()
        setAgents(Array.isArray(agentsData) ? agentsData : (agentsData.agents ?? []))
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    try {
      const res = await fetch('/api/scheduled-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:      form.name,
          agentId:   form.agentId,
          cronExpr:  form.cronExpr,
          taskTitle: form.taskTitle,
          taskDesc:  form.taskDesc || undefined,
          enabled:   form.enabled,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        setFormError(data.error ?? 'Failed to create schedule')
        return
      }
      setShowForm(false)
      setForm({ name: '', agentId: '', cronExpr: '', taskTitle: '', taskDesc: '', enabled: true })
      await load()
    } catch (e) {
      setFormError(String(e))
    }
  }

  async function handleToggle(schedule: ScheduledTask) {
    setToggling(schedule.id)
    try {
      await fetch(`/api/scheduled-tasks/${schedule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      })
      await load()
    } finally {
      setToggling(null)
    }
  }

  async function handleTrigger(id: string) {
    setTriggering(id)
    try {
      const res = await fetch(`/api/scheduled-tasks/${id}/trigger`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to trigger')
      } else {
        await load()
      }
    } finally {
      setTriggering(null)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this scheduled task?')) return
    setDeleting(id)
    try {
      await fetch(`/api/scheduled-tasks/${id}`, { method: 'DELETE' })
      await load()
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Scheduled Tasks</h1>
          <p className="text-sm text-text-secondary mt-0.5">Cron-style recurring task scheduling</p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/80 transition-colors"
        >
          <Plus size={15} />
          New Schedule
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400 flex items-center justify-between">
          {error}
          <button onClick={() => setError(null)}><X size={14} /></button>
        </div>
      )}

      {showForm && (
        <div className="mb-6 p-4 bg-bg-raised border border-border-subtle rounded-lg">
          <h2 className="text-sm font-semibold text-text-primary mb-4">New Scheduled Task</h2>
          <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Schedule Name</label>
              <input
                className="w-full px-3 py-1.5 text-sm bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent"
                placeholder="e.g. Daily health check"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Agent</label>
              <select
                className="w-full px-3 py-1.5 text-sm bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent"
                value={form.agentId}
                onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))}
                required
              >
                <option value="">Select agent...</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Cron Expression</label>
              <input
                className="w-full px-3 py-1.5 text-sm bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent font-mono"
                placeholder="0 2 * * *  (daily at 02:00)"
                value={form.cronExpr}
                onChange={e => setForm(f => ({ ...f, cronExpr: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Task Title</label>
              <input
                className="w-full px-3 py-1.5 text-sm bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent"
                placeholder="Title for each spawned task"
                value={form.taskTitle}
                onChange={e => setForm(f => ({ ...f, taskTitle: e.target.value }))}
                required
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-text-secondary mb-1">Task Description (optional)</label>
              <textarea
                className="w-full px-3 py-1.5 text-sm bg-bg-base border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent resize-none"
                rows={2}
                placeholder="Description for each spawned task"
                value={form.taskDesc}
                onChange={e => setForm(f => ({ ...f, taskDesc: e.target.value }))}
              />
            </div>
            <div className="md:col-span-2 flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                  className="accent-accent"
                />
                Enabled
              </label>
              {formError && <span className="text-xs text-red-400">{formError}</span>}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => { setShowForm(false); setFormError(null) }}
                  className="px-3 py-1.5 text-sm border border-border-subtle rounded text-text-secondary hover:bg-bg-raised"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/80"
                >
                  Create
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-text-secondary">Loading...</div>
      ) : schedules.length === 0 ? (
        <div className="text-sm text-text-secondary py-8 text-center">
          No scheduled tasks yet. Click &quot;New Schedule&quot; to create one.
        </div>
      ) : (
        <div className="border border-border-subtle rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-raised border-b border-border-subtle">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Name</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Agent</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Cron</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Next Run</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Last Run</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Enabled</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {schedules.map(s => (
                <tr key={s.id} className="hover:bg-bg-raised/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-text-primary">{s.name}</div>
                    {s.description && (
                      <div className="text-xs text-text-secondary mt-0.5">{s.description}</div>
                    )}
                    <div className="text-xs text-text-muted mt-0.5">{s.taskTitle}</div>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{s.agent.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">{s.cronExpr}</td>
                  <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap">
                    <span className="flex items-center gap-1">
                      <Clock size={11} />
                      {formatDate(s.nextRunAt)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-text-secondary whitespace-nowrap">
                    {formatDate(s.lastRunAt)}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggle(s)}
                      disabled={toggling === s.id}
                      title={s.enabled ? 'Disable' : 'Enable'}
                      className={`w-8 h-5 rounded-full transition-colors flex items-center justify-center ${
                        s.enabled
                          ? 'bg-green-500/80 hover:bg-green-500'
                          : 'bg-bg-raised hover:bg-bg-raised/80 border border-border-subtle'
                      }`}
                    >
                      {s.enabled
                        ? <Check size={11} className="text-white" />
                        : <X size={11} className="text-text-muted" />
                      }
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleTrigger(s.id)}
                        disabled={triggering === s.id}
                        title="Trigger now"
                        className="p-1.5 text-text-secondary hover:text-accent hover:bg-accent/10 rounded transition-colors"
                      >
                        <Play size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(s.id)}
                        disabled={deleting === s.id}
                        title="Delete"
                        className="p-1.5 text-text-secondary hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
