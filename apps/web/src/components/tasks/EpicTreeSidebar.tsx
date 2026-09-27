'use client'
import type { Epic, Task, SelectionState } from '@/types/tasks'
import { EpicTreeNav } from './EpicTreeNav'

interface Props {
  epics: Epic[]
  tasks: Task[]
  selection: SelectionState
  onSelect: (s: SelectionState) => void
  onNewEpic: () => void
  onNewFeature: (epicId: string) => void
  mobileOpen: boolean
  onMobileClose: () => void
}

/** Epic/feature tree: inline column on desktop, slide-over on mobile. */
export function EpicTreeSidebar({ epics, tasks, selection, onSelect, onNewEpic, onNewFeature, mobileOpen, onMobileClose }: Props) {
  return (
    <>
      {/* Desktop */}
      <div className="hidden md:flex">
        <EpicTreeNav
          epics={epics}
          tasks={tasks}
          selection={selection}
          onSelect={onSelect}
          onNewEpic={onNewEpic}
          onNewFeature={onNewFeature}
        />
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="md:hidden absolute inset-0 z-50 flex">
          <EpicTreeNav
            epics={epics}
            tasks={tasks}
            selection={selection}
            onSelect={s => { onSelect(s); onMobileClose() }}
            onNewEpic={() => { onNewEpic(); onMobileClose() }}
            onNewFeature={epicId => { onNewFeature(epicId); onMobileClose() }}
          />
          <button
            type="button"
            aria-label="Close epic list"
            className="flex-1 bg-black/60 cursor-default"
            onClick={onMobileClose}
          />
        </div>
      )}
    </>
  )
}
