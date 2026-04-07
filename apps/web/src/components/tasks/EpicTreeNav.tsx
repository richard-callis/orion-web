'use client'
import { useState } from 'react'
import { ChevronRight, ChevronDown, Plus, Layers, GitBranch, Inbox } from 'lucide-react'
import type { Epic, SelectionState } from '@/types/tasks'

interface Props {
  epics: Epic[]
  tasks: { featureId: string | null }[]
  selection: SelectionState
  onSelect: (s: SelectionState) => void
  onNewEpic: () => void
  onNewFeature: (epicId: string) => void
}

export function EpicTreeNav({ epics, tasks, selection, onSelect, onNewEpic, onNewFeature }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const totalTasks = tasks.length
  const unassigned = tasks.filter(t => !t.featureId).length

  const epicTaskCount = (epic: Epic) =>
    epic.features.reduce((n, f) => n + (f._count?.tasks ?? 0), 0)

  const isActive = (s: SelectionState) => {
    if (s.kind !== selection.kind) return false
    if (s.kind === 'all' || s.kind === 'unassigned') return true
    if (s.kind === 'epic' && selection.kind === 'epic') return s.epicId === selection.epicId
    if (s.kind === 'feature' && selection.kind === 'feature') return s.featureId === selection.featureId
    return false
  }

  const rowBase = 'flex items-center gap-2 px-3 py-1.5 text-xs rounded cursor-pointer transition-colors select-none'
  const rowActive = 'bg-accent/15 text-accent'
  const rowIdle = 'text-text-secondary hover:bg-bg-raised hover:text-text-primary'

  return (
    <aside className="w-56 flex-shrink-0 flex flex-col border-r border-border-subtle bg-bg-sidebar overflow-hidden">
      <div className="px-3 py-3 border-b border-border-subtle flex-shrink-0">
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wide">Project Tree</span>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {/* All Tasks */}
        <div
          onClick={() => onSelect({ kind: 'all' })}
          className={`${rowBase} ${isActive({ kind: 'all' }) ? rowActive : rowIdle}`}
        >
          <Layers size={13} className="flex-shrink-0" />
          <span className="flex-1">All Tasks</span>
          <span className="text-[10px] text-text-muted">{totalTasks}</span>
        </div>

        {/* Epics */}
        {epics.length > 0 && <div className="mx-3 my-1 border-t border-border-subtle" />}

        {epics.map(epic => {
          const isOpen = expanded.has(epic.id)
          const epicSel: SelectionState = { kind: 'epic', epicId: epic.id }
          return (
            <div key={epic.id}>
              <div className={`${rowBase} ${isActive(epicSel) ? rowActive : rowIdle}`}>
                <button
                  onClick={e => { e.stopPropagation(); toggle(epic.id) }}
                  className="flex-shrink-0 -ml-0.5"
                >
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <span className="flex-1 font-medium truncate" onClick={() => { onSelect(epicSel); if (!isOpen) toggle(epic.id) }}>
                  {epic.title}
                </span>
                <span className="text-[10px] text-text-muted" onClick={() => onSelect(epicSel)}>
                  {epicTaskCount(epic)}
                </span>
              </div>

              {isOpen && (
                <div className="ml-3 border-l border-border-subtle pl-2 mb-1">
                  {epic.features.map(f => {
                    const fSel: SelectionState = { kind: 'feature', epicId: epic.id, featureId: f.id }
                    return (
                      <div
                        key={f.id}
                        onClick={() => onSelect(fSel)}
                        className={`${rowBase} ${isActive(fSel) ? rowActive : rowIdle}`}
                      >
                        <GitBranch size={11} className="flex-shrink-0 text-text-muted" />
                        <span className="flex-1 truncate">{f.title}</span>
                        <span className="text-[10px] text-text-muted">{f._count?.tasks ?? 0}</span>
                      </div>
                    )
                  })}
                  <button
                    onClick={() => onNewFeature(epic.id)}
                    className="flex items-center gap-1.5 px-3 py-1 text-[10px] text-text-muted hover:text-accent w-full"
                  >
                    <Plus size={10} /> New Feature
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {/* Unassigned */}
        <div className="mx-3 my-1 border-t border-border-subtle" />
        <div
          onClick={() => onSelect({ kind: 'unassigned' })}
          className={`${rowBase} ${isActive({ kind: 'unassigned' }) ? rowActive : rowIdle}`}
        >
          <Inbox size={13} className="flex-shrink-0" />
          <span className="flex-1">Unassigned</span>
          <span className="text-[10px] text-text-muted">{unassigned}</span>
        </div>
      </div>

      {/* New Epic */}
      <button
        onClick={onNewEpic}
        className="flex items-center gap-2 px-3 py-2.5 text-xs text-text-muted hover:text-accent border-t border-border-subtle hover:bg-bg-raised transition-colors"
      >
        <Plus size={13} /> New Epic
      </button>
    </aside>
  )
}
