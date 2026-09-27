'use client'
import { useId, useState } from 'react'
import useSWR from 'swr'
import { Plus, Trash2, Play, Clock, Check, X, CalendarClock } from 'lucide-react'
import { apiFetch, errorMessage } from '@/lib/api'
import { useAgents } from '@/hooks/useAgents'
import { IconButton } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { CronBuilder } from './CronBuilder'
import { ConfirmInline, formatDate, thCls, type ScheduledTask } from './job-types'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
const EMPTY_FORM = { name: '', agentId: '', cronExpr: '0 9 * * *', taskTitle: '', taskDesc: '', enabled: true }

export function SchedulesTab() {
  const toast = useToast()
  const { data: schedules = [], isLoading, mutate } = useSWR<ScheduledTask[]>('/api/scheduled-tasks')
  const { agents } = useAgents()
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  /** Run a per-row action; failures (e.g. 403 on someone else's schedule) are toasted. */
  const act = async (id: string, what: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    try {
      await fn()
      await mutate()
    } catch (e) {
      toast.error(`Failed to ${what}: ${errorMessage(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">{schedules.length} schedule{schedules.length !== 1 ? 's' : ''}</p>
        <button onClick={() => setShowForm(v => !v)} aria-expanded={showForm} className="flex items-center gap-2 px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/80 transition-colors">
          <Plus size={15} /> New Schedule
        </button>
      </div>

      {showForm && (
        <NewScheduleForm
          agents={agents}
          onCancel={() => setShowForm(false)}
          onCreated={() => { setShowForm(false); void mutate() }}
        />
      )}

      {isLoading ? <div className="text-sm text-text-secondary">Loading...</div> : schedules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <CalendarClock size={32} className="text-text-muted/40" />
          <p className="text-sm font-medium text-text-secondary">No scheduled tasks yet</p>
          <p className="text-xs text-text-muted max-w-xs">Schedule recurring tasks using cron expressions. Click <strong>+ New Schedule</strong> to get started.</p>
        </div>
      ) : (
        <div className="border border-border-subtle rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-bg-raised border-b border-border-subtle">
              {['Name', 'Agent', 'Cron', 'Next Run', 'Last Run', 'Enabled', 'Actions'].map(h => <th key={h} className={thCls}>{h}</th>)}
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
                    <button
                      role="switch"
                      aria-checked={s.enabled}
                      aria-label={`Enable ${s.name}`}
                      onClick={() => act(s.id, 'update schedule', () => apiFetch(`/api/scheduled-tasks/${s.id}`, { method: 'PUT', body: { enabled: !s.enabled } }))}
                      disabled={busy === s.id}
                      className={`w-8 h-5 rounded-full transition-colors flex items-center justify-center ${s.enabled ? 'bg-green-500/80 hover:bg-green-500' : 'bg-bg-raised border border-border-subtle'}`}
                    >
                      {s.enabled ? <Check size={11} className="text-white" /> : <X size={11} className="text-text-muted" />}
                    </button>
                  </td>
                  <td className="px-4 py-3"><div className="flex items-center gap-2">
                    <IconButton label={`Trigger ${s.name} now`} disabled={busy === s.id}
                      onClick={() => act(s.id, 'trigger schedule', () => apiFetch(`/api/scheduled-tasks/${s.id}/trigger`, { method: 'POST' }))}
                      className="p-1.5 text-text-secondary hover:text-accent hover:bg-accent/10">
                      <Play size={13} />
                    </IconButton>
                    {pendingDelete === s.id ? (
                      <ConfirmInline
                        label="Confirm"
                        onCancel={() => setPendingDelete(null)}
                        onConfirm={() => { setPendingDelete(null); void act(s.id, 'delete schedule', () => apiFetch(`/api/scheduled-tasks/${s.id}`, { method: 'DELETE' })) }}
                      />
                    ) : (
                      <IconButton label={`Delete ${s.name}`} disabled={busy === s.id} onClick={() => setPendingDelete(s.id)}
                        className="p-1.5 text-text-secondary hover:text-red-400 hover:bg-red-500/10">
                        <Trash2 size={13} />
                      </IconButton>
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

function NewScheduleForm({ agents, onCancel, onCreated }: { agents: Array<{ id: string; name: string }>; onCancel: () => void; onCreated: () => void }) {
  const id = useId()
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await apiFetch('/api/scheduled-tasks', {
        method: 'POST',
        body: { name: form.name, agentId: form.agentId, cronExpr: form.cronExpr, taskTitle: form.taskTitle, taskDesc: form.taskDesc || undefined, enabled: form.enabled },
      })
      onCreated()
    } catch (err) {
      setError(errorMessage(err, 'Request failed'))
    } finally {
      setSaving(false)
    }
  }

  const label = (suffix: string, text: string) => <label htmlFor={`${id}-${suffix}`} className="block text-xs text-text-secondary mb-1">{text}</label>

  return (
    <div className="p-4 bg-bg-raised border border-border-subtle rounded-lg">
      <h2 className="text-sm font-semibold text-text-primary mb-4">New Scheduled Task</h2>
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>{label('name', 'Schedule Name')}<Input id={`${id}-name`} className="py-1.5 bg-bg-base" placeholder="e.g. Daily health check" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required /></div>
        <div>{label('agent', 'Agent')}<Select id={`${id}-agent`} className="py-1.5 bg-bg-base" value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))} required><option value="">Select agent...</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></div>
        <div className="md:col-span-2"><CronBuilder value={form.cronExpr} onChange={cronExpr => setForm(f => ({ ...f, cronExpr }))} /></div>
        <div>{label('title', 'Task Title')}<Input id={`${id}-title`} className="py-1.5 bg-bg-base" placeholder="Title for each spawned task" value={form.taskTitle} onChange={e => setForm(f => ({ ...f, taskTitle: e.target.value }))} required /></div>
        <div className="md:col-span-2">{label('desc', 'Task Description (optional)')}<Textarea id={`${id}-desc`} className="py-1.5 bg-bg-base" rows={2} value={form.taskDesc} onChange={e => setForm(f => ({ ...f, taskDesc: e.target.value }))} /></div>
        <div className="md:col-span-2 flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer"><input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="accent-accent" />Enabled</label>
          {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm border border-border-subtle rounded text-text-secondary hover:bg-bg-raised">Cancel</button>
            <button type="submit" disabled={saving} className="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50">{saving ? 'Creating…' : 'Create'}</button>
          </div>
        </div>
      </form>
    </div>
  )
}
