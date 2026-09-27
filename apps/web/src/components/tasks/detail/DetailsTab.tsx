'use client'
import { useEffect, useId, useState } from 'react'
import type { Agent, Task } from '@/types/tasks'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { Textarea } from '../../ui/Textarea'
import { fieldLabelClass, priorityConfig, statusConfig, taskFieldClass, type SimpleUser } from '../task-config'
import { DependenciesTab } from './DependenciesTab'

interface Props {
  task: Task
  tasks: Task[]
  agents: Agent[]
  users: SimpleUser[]
  columns: string[]
  onUpdate: (patch: Partial<Task>) => void
}

export function DetailsTab({ task, tasks, agents, users, columns, onUpdate }: Props) {
  const ids = {
    title: useId(), priority: useId(), agent: useId(), user: useId(), desc: useId(), plan: useId(),
  }
  const [title, setTitle]       = useState(task.title)
  const [desc, setDesc]         = useState(task.description ?? '')
  const [plan, setPlan]         = useState(task.plan ?? '')
  const [priority, setPriority] = useState(task.priority)

  // Reset the edit buffers when a different task is shown.
  useEffect(() => {
    setTitle(task.title)
    setDesc(task.description ?? '')
    setPlan(task.plan ?? '')
    setPriority(task.priority)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on task switch, not on every save
  }, [task.id])

  const activeAgents = agents.filter(a => !(a.metadata as Record<string, unknown> | null)?.archived)
  const saveDetail = () => onUpdate({ title, description: desc || null, priority })

  return (
    <>
      <div>
        <label htmlFor={ids.title} className={fieldLabelClass}>Title</label>
        <Input id={ids.title} value={title} onChange={e => setTitle(e.target.value)} onBlur={saveDetail}
          className={taskFieldClass} />
      </div>
      <div>
        <label htmlFor={ids.priority} className={fieldLabelClass}>Priority</label>
        <Select id={ids.priority} value={priority}
          onChange={e => { setPriority(e.target.value); onUpdate({ priority: e.target.value }) }}
          className={taskFieldClass}>
          {Object.entries(priorityConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </div>
      <div>
        <label htmlFor={ids.agent} className={fieldLabelClass}>Assigned To (Agent)</label>
        <Select
          id={ids.agent}
          value={task.assignedAgent ?? ''}
          onChange={e => {
            const agentId = e.target.value || null
            const agent = agents.find(a => a.id === agentId) ?? null
            onUpdate({ assignedAgent: agentId, agent })
          }}
          className={taskFieldClass}
        >
          <option value="">— No agent —</option>
          {activeAgents.map(a => <option key={a.id} value={a.id}>{a.name}{a.role ? ` (${a.role})` : ''}</option>)}
        </Select>
      </div>
      {users.length > 0 && (
        <div>
          <label htmlFor={ids.user} className={fieldLabelClass}>Assigned To (User)</label>
          <Select
            id={ids.user}
            value={task.assignedUserId ?? ''}
            onChange={e => {
              const userId = e.target.value || null
              const assignedUser = users.find(u => u.id === userId) ?? null
              onUpdate({ assignedUserId: userId, assignedUser })
            }}
            className={taskFieldClass}
          >
            <option value="">— No user —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name ?? u.username}</option>)}
          </Select>
        </div>
      )}
      <div role="group" aria-label="Status">
        <span className={fieldLabelClass}>Status</span>
        <div className="grid grid-cols-2 gap-1.5">
          {columns.map(col => (
            <button key={col} onClick={() => onUpdate({ status: col })}
              aria-pressed={task.status === col}
              className={`px-2 py-1.5 rounded text-[10px] font-medium transition-colors ${
                task.status === col ? 'bg-accent text-white' : 'bg-bg-raised text-text-muted hover:text-text-primary hover:bg-bg-card border border-border-subtle'
              }`}>
              {statusConfig(col).label}
            </button>
          ))}
        </div>
      </div>
      <DependenciesTab task={task} tasks={tasks} onChange={dependsOn => onUpdate({ dependsOn })} />
      <div>
        <label htmlFor={ids.desc} className={fieldLabelClass}>Your Description</label>
        <Textarea id={ids.desc} value={desc} onChange={e => setDesc(e.target.value)} onBlur={saveDetail} rows={4}
          placeholder="What needs to be done, context, requirements..."
          className={taskFieldClass} />
      </div>
      <div>
        <label htmlFor={ids.plan} className="text-[10px] text-accent uppercase tracking-wide mb-1 block">Claude&apos;s Plan</label>
        <Textarea id={ids.plan} value={plan} onChange={e => setPlan(e.target.value)} onBlur={() => onUpdate({ plan: plan || null })} rows={6}
          placeholder="No plan yet — use 'Plan with AI' to generate one..."
          className={`${taskFieldClass} border-accent/30 bg-accent/5`} />
      </div>
      <p className="text-[10px] text-text-muted">Created {new Date(task.createdAt).toLocaleDateString()}</p>
    </>
  )
}
