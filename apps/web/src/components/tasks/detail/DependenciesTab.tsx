'use client'
import { useId, useState } from 'react'
import { Plus, X, Lock, CheckCircle2, Layers } from 'lucide-react'
import type { Task } from '@/types/tasks'
import { IconButton } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { fieldLabelClass, taskFieldClass } from '../task-config'

interface Props {
  task: Task
  tasks: Task[]
  onChange: (dependsOn: string[]) => void
}

/** Dependency list + "add dependency" search for one task (rendered inside the Details tab). */
export function DependenciesTab({ task, tasks, onChange }: Props) {
  const [search, setSearch] = useState('')
  const searchId = useId()
  const deps = task.dependsOn ?? []

  const q = search.trim().toLowerCase()
  const candidates = q.length > 1
    ? tasks.filter(t => t.id !== task.id && !deps.includes(t.id) && t.title.toLowerCase().includes(q)).slice(0, 5)
    : []

  return (
    <div>
      <label htmlFor={searchId} className={`${fieldLabelClass} flex items-center gap-1`}>
        <Layers size={10} /> Dependencies
      </label>
      {/* Current deps */}
      {deps.length > 0 && (
        <div className="space-y-1 mb-2">
          {deps.map(depId => {
            const dep = tasks.find(t => t.id === depId)
            return dep ? (
              <div key={depId} className="flex items-center gap-1.5 text-[10px] text-text-muted bg-bg-card rounded px-2 py-1">
                {dep.status === 'done' ? <CheckCircle2 size={10} className="text-emerald-400" /> : <Lock size={10} className="text-amber-400" />}
                <span className="flex-1 truncate">{dep.title}</span>
                <span className="text-text-muted/60 mr-1">{dep.status}</span>
                <IconButton
                  label={`Remove dependency on ${dep.title}`}
                  onClick={() => onChange(deps.filter(d => d !== depId))}
                  className="p-0 text-text-muted/40 hover:text-red-400"
                >
                  <X size={9} />
                </IconButton>
              </div>
            ) : null
          })}
        </div>
      )}
      {/* Add dep search */}
      <Input
        id={searchId}
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search tasks to add as dependency…"
        className={`${taskFieldClass} text-xs`}
      />
      {candidates.length > 0 && (
        <div className="border border-border-subtle rounded mt-1 overflow-hidden">
          {candidates.map(t => (
            <button
              key={t.id}
              onClick={() => { onChange([...deps, t.id]); setSearch('') }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-text-secondary hover:bg-accent/10 hover:text-text-primary flex items-center gap-2 transition-colors"
            >
              <Plus size={9} className="text-accent flex-shrink-0" />
              <span className="truncate">{t.title}</span>
            </button>
          ))}
        </div>
      )}
      {/* Wave */}
      {task.wave != null && (
        <p className="text-[10px] text-text-muted mt-1.5">Execution wave: {task.wave}</p>
      )}
    </div>
  )
}
