'use client'
import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X, MessageSquare, Trash2, ChevronRight, Flag } from 'lucide-react'

export interface Task {
  id: string
  title: string
  description: string | null
  plan: string | null
  status: string
  priority: string
  createdAt: string
  updatedAt: string
}

const COLUMNS = ['pending', 'in_progress', 'done', 'failed'] as const
type Status = typeof COLUMNS[number]

const colLabel: Record<Status, string> = {
  pending:     'Backlog',
  in_progress: 'In Progress',
  done:        'Done',
  failed:      'Failed',
}

const colHeader: Record<Status, string> = {
  pending:     'border-t-border-visible',
  in_progress: 'border-t-accent',
  done:        'border-t-status-healthy',
  failed:      'border-t-status-error',
}

const priorityConfig: Record<string, { label: string; color: string; dot: string }> = {
  critical: { label: 'Critical', color: 'text-status-error',   dot: 'bg-status-error' },
  high:     { label: 'High',     color: 'text-status-warning', dot: 'bg-status-warning' },
  medium:   { label: 'Medium',   color: 'text-accent',         dot: 'bg-accent' },
  low:      { label: 'Low',      color: 'text-text-muted',     dot: 'bg-border-visible' },
}

interface NewTaskForm { title: string; description: string; priority: string }

export function TaskBoard({ initialTasks }: { initialTasks: Task[] }) {
  const router = useRouter()
  const [tasks, setTasks] = useState<Task[]>(initialTasks)
  const [selected, setSelected] = useState<Task | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<NewTaskForm>({ title: '', description: '', priority: 'medium' })
  const [saving, setSaving] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPlan, setEditPlan] = useState('')
  const [editPriority, setEditPriority] = useState('medium')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (selected) {
      setEditTitle(selected.title)
      setEditDesc(selected.description ?? '')
      setEditPlan(selected.plan ?? '')
      setEditPriority(selected.priority)
    }
  }, [selected?.id])

  const byStatus = (s: Status) => tasks.filter(t => t.status === s)

  const updateTask = async (id: string, patch: Partial<Task>) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
    if (selected?.id === id) setSelected(prev => prev ? { ...prev, ...patch } : null)
    await fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {})
  }

  const deleteTask = async (id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id))
    if (selected?.id === id) setSelected(null)
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  const createTask = async () => {
    if (!form.title.trim()) return
    setSaving(true)
    const r = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: form.title, description: form.description || null, priority: form.priority, createdBy: 'admin' }),
    })
    const task: Task = await r.json()
    setTasks(prev => [task, ...prev])
    setForm({ title: '', description: '', priority: 'medium' })
    setShowCreate(false)
    setSaving(false)
    setSelected(task)
  }

  const saveDetail = async () => {
    if (!selected) return
    await updateTask(selected.id, { title: editTitle, description: editDesc || null, priority: editPriority })
  }

  const savePlan = async () => {
    if (!selected) return
    await updateTask(selected.id, { plan: editPlan || null })
  }

  const planWithClaude = async (task: Task) => {
    const r = await fetch('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: task.title }),
    })
    const convo = await r.json()
    const ctx = encodeURIComponent(
      `I want to plan and design the following task:\n\n**${task.title}**\n\n${task.description ?? 'No description yet.'}\n\nHelp me break this down into a clear implementation plan.`
    )
    router.push(`/chat?conversation=${convo.id}&task=${task.id}&context=${ctx}`)
  }

  return (
    <div className="flex h-full gap-0">
      {/* Board */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <h1 className="text-sm font-semibold text-text-secondary">Tasks ({tasks.length})</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent/80 transition-colors"
          >
            <Plus size={14} /> New Task
          </button>
        </div>

        <div className="flex gap-3 flex-1 overflow-x-auto overflow-y-hidden">
          {COLUMNS.map(col => (
            <div key={col} className={`flex-shrink-0 w-64 flex flex-col rounded-lg border border-border-subtle bg-bg-card border-t-2 ${colHeader[col]}`}>
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-subtle">
                <span className="text-xs font-semibold text-text-secondary">{colLabel[col]}</span>
                <span className="text-xs text-text-muted bg-bg-raised px-1.5 py-0.5 rounded">{byStatus(col).length}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {byStatus(col).map(task => {
                  const p = priorityConfig[task.priority] ?? priorityConfig.medium
                  const isSelected = selected?.id === task.id
                  return (
                    <div
                      key={task.id}
                      onClick={() => setSelected(isSelected ? null : task)}
                      className={`rounded-lg border p-3 cursor-pointer transition-all ${
                        isSelected ? 'border-accent bg-accent/10' : 'border-border-subtle bg-bg-raised hover:border-border-visible'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs text-text-primary leading-snug flex-1">{task.title}</p>
                        <ChevronRight size={12} className={`flex-shrink-0 mt-0.5 text-text-muted transition-transform ${isSelected ? 'rotate-90' : ''}`} />
                      </div>
                      {task.description && (
                        <p className="text-[10px] text-text-muted mt-1.5 line-clamp-2 leading-relaxed">{task.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.dot}`} />
                        <span className={`text-[10px] ${p.color}`}>{p.label}</span>
                        {task.plan && <span className="text-[10px] text-accent ml-auto">has plan</span>}
                      </div>
                    </div>
                  )
                })}
                {byStatus(col).length === 0 && (
                  <p className="text-[10px] text-text-muted text-center py-4">No tasks</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <aside className="w-80 flex-shrink-0 flex flex-col border-l border-border-subtle bg-bg-sidebar ml-4 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <span className="text-xs font-semibold text-text-secondary">Task Detail</span>
            <button onClick={() => setSelected(null)} className="text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Title */}
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Title</label>
              <input
                ref={titleRef}
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onBlur={saveDetail}
                className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
              />
            </div>

            {/* Priority */}
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Priority</label>
              <select
                value={editPriority}
                onChange={e => { setEditPriority(e.target.value); updateTask(selected.id, { priority: e.target.value }) }}
                className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
              >
                {Object.entries(priorityConfig).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>

            {/* Status */}
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Status</label>
              <div className="grid grid-cols-2 gap-1.5">
                {COLUMNS.map(col => (
                  <button
                    key={col}
                    onClick={() => updateTask(selected.id, { status: col })}
                    className={`px-2 py-1.5 rounded text-[10px] font-medium transition-colors ${
                      selected.status === col
                        ? 'bg-accent text-white'
                        : 'bg-bg-raised text-text-muted hover:text-text-primary hover:bg-bg-card border border-border-subtle'
                    }`}
                  >
                    {colLabel[col]}
                  </button>
                ))}
              </div>
            </div>

            {/* Your description */}
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Your Description</label>
              <textarea
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                onBlur={saveDetail}
                rows={4}
                placeholder="What needs to be done, context, requirements..."
                className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed"
              />
            </div>

            {/* Claude's plan */}
            <div>
              <label className="text-[10px] text-accent uppercase tracking-wide mb-1 block">Claude&apos;s Plan</label>
              <textarea
                value={editPlan}
                onChange={e => setEditPlan(e.target.value)}
                onBlur={savePlan}
                rows={6}
                placeholder="No plan yet — use 'Plan with Claude' to generate one..."
                className="w-full px-2.5 py-1.5 text-sm rounded border border-accent/30 bg-accent/5 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed"
              />
            </div>

            <p className="text-[10px] text-text-muted">
              Created {new Date(selected.createdAt).toLocaleDateString()}
            </p>
          </div>

          <div className="p-3 border-t border-border-subtle space-y-2">
            <button
              onClick={() => planWithClaude(selected)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-accent text-white text-sm hover:bg-accent/80 transition-colors"
            >
              <MessageSquare size={14} /> Plan with Claude
            </button>
            <button
              onClick={() => deleteTask(selected.id)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-border-subtle text-text-muted text-sm hover:border-status-error hover:text-status-error transition-colors"
            >
              <Trash2 size={14} /> Delete Task
            </button>
          </div>
        </aside>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-bg-card border border-border-visible rounded-xl p-6 w-[480px] max-w-[90vw] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-text-primary">New Task</h2>
              <button onClick={() => setShowCreate(false)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Title *</label>
                <input
                  autoFocus
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && createTask()}
                  placeholder="What needs to be done?"
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Your Description</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  rows={4}
                  placeholder="Context, goals, requirements..."
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed"
                />
              </div>

              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Priority</label>
                <div className="flex gap-2">
                  {Object.entries(priorityConfig).map(([k, v]) => (
                    <button
                      key={k}
                      onClick={() => setForm(f => ({ ...f, priority: k }))}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs border transition-colors ${
                        form.priority === k
                          ? 'border-accent bg-accent/15 text-accent'
                          : 'border-border-subtle text-text-muted hover:border-border-visible'
                      }`}
                    >
                      <Flag size={10} />
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-text-muted hover:text-text-primary">
                Cancel
              </button>
              <button
                onClick={createTask}
                disabled={!form.title.trim() || saving}
                className="px-4 py-2 text-sm rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Creating…' : 'Create Task'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
