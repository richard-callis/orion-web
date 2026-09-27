'use client'
import { Plus, Menu } from 'lucide-react'
import type { Epic, SelectionState } from '@/types/tasks'
import { Button, IconButton } from '../ui/Button'

interface Props {
  view: 'tasks' | 'my-tasks'
  selection: SelectionState
  epics: Epic[]
  totalCount: number
  visibleCount: number
  onOpenTree: () => void
  onViewEpic: (epic: Epic) => void
  onViewFeature: (epic: Epic, featureId: string) => void
  onNewTask: () => void
}

function heading({ view, selection, epics, totalCount, visibleCount }: Pick<Props, 'view' | 'selection' | 'epics' | 'totalCount' | 'visibleCount'>): string {
  if (view === 'my-tasks') return `My Tasks (${visibleCount})`
  switch (selection.kind) {
    case 'all':        return `All Tasks (${totalCount})`
    case 'unassigned': return `Unassigned Tasks (${visibleCount})`
    case 'epic':       return `${epics.find(e => e.id === selection.epicId)?.title ?? 'Epic'} (${visibleCount})`
    case 'feature': {
      const feat = epics.find(e => e.id === selection.epicId)?.features.find(f => f.id === selection.featureId)
      return `${feat?.title ?? 'Feature'} (${visibleCount})`
    }
  }
}

export function TaskBoardToolbar(props: Props) {
  const { view, selection, epics, onOpenTree, onViewEpic, onViewFeature, onNewTask } = props
  return (
    <div className="flex items-center justify-between mb-4 flex-shrink-0">
      <div className="flex items-center gap-2">
        {/* Mobile: open epic tree */}
        <IconButton
          label="Browse epics"
          onClick={onOpenTree}
          className="md:hidden p-1.5 hover:bg-bg-raised"
        >
          <Menu size={16} />
        </IconButton>
        <h1 className="text-sm font-semibold text-text-secondary">{heading(props)}</h1>
        {/* Show epic/feature detail button — tasks view only */}
        {view === 'tasks' && selection.kind === 'epic' && (
          <button
            onClick={() => {
              const epic = epics.find(e => e.id === selection.epicId)
              if (epic) onViewEpic(epic)
            }}
            className="text-[10px] text-accent hover:underline"
          >
            View Epic →
          </button>
        )}
        {view === 'tasks' && selection.kind === 'feature' && (
          <button
            onClick={() => {
              const epic = epics.find(e => e.id === selection.epicId)
              if (epic) onViewFeature(epic, selection.featureId)
            }}
            className="text-[10px] text-accent hover:underline"
          >
            View Feature →
          </button>
        )}
      </div>
      {view === 'tasks' && (
        <Button size="md" onClick={onNewTask} className="px-3 py-1.5 font-normal">
          <Plus size={14} /> New Task
        </Button>
      )}
    </div>
  )
}
