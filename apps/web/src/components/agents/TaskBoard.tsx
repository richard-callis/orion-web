'use client'
import { useState } from 'react'
import { Plus } from 'lucide-react'

interface Task {
  id: string
  title: string
  status: string
  priority: string
  agent?: { name: string } | null
}

const COLUMNS = ['pending', 'in_progress', 'done', 'failed'] as const
type Status = typeof COLUMNS[number]

const colLabel: Record<Status, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  done: 'Done',
  failed: 'Failed',
}

const priorityColor: Record<string, string> = {
  critical: 'border-l-status-error',
  high:     'border-l-status-warning',
  medium:   'border-l-accent',
  low:      'border-l-border-visible',
}

export function TaskBoard({ initialTasks, agents }: { initialTasks: Task[]; agents: { id: string; name: string }[] }) {
  const [tasks, setTasks] = useState(initialTasks)
  const [newTitle, setNewTitle] = useState('')

  const byStatus = (s: Status) => tasks.filter(t => t.status === s)

  const move = async (id: string, status: Status) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status } : t))
    await fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => {})
  }

  const create = async () => {
    if (!newTitle.trim()) return
    const r = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle, createdBy: 'admin' }),
    })
    const task = await r.json()
    setTasks(prev => [task, ...prev])
    setNewTitle('')
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-4">
      {/* Add task */}
      <div className="flex gap-2 mb-4">
        <input
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && create()}
          placeholder="New task title..."
          className="flex-1 px-3 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
        />
        <button onClick={create} className="flex items-center gap-1 px-3 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent/80">
          <Plus size={14} /> Add
        </button>
      </div>

      {/* Board */}
      <div className="flex gap-3 flex-1 overflow-x-auto">
        {COLUMNS.map(col => (
          <div key={col} className="flex-shrink-0 w-56 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-text-secondary">{colLabel[col]}</span>
              <span className="text-xs text-text-muted">{byStatus(col).length}</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto">
              {byStatus(col).map(task => (
                <div
                  key={task.id}
                  className={`rounded-lg border border-border-subtle bg-bg-card p-2.5 border-l-2 ${priorityColor[task.priority] ?? 'border-l-border-visible'}`}
                >
                  <p className="text-xs text-text-primary leading-snug">{task.title}</p>
                  {task.agent && <p className="text-[10px] text-text-muted mt-1">{task.agent.name}</p>}
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {COLUMNS.filter(c => c !== col).map(c => (
                      <button
                        key={c}
                        onClick={() => move(task.id, c)}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted hover:text-accent hover:bg-accent/10"
                      >
                        → {colLabel[c]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
