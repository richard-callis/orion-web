'use client'
import { useState, useMemo, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { User } from 'lucide-react'
import type { Agent, Task, Epic, SelectionState, Bug } from '@/types/tasks'
import { BugManager } from './BugManager'
import { Dialog } from '../ui/Dialog'
import { EpicDetailPanel } from './EpicDetailPanel'
import { FeatureDetailPanel } from './FeatureDetailPanel'
import { EpicTreeSidebar } from './EpicTreeSidebar'
import { TaskBoardToolbar } from './TaskBoardToolbar'
import { TaskBoard } from './TaskBoard'
import { TaskDetailPanel } from './detail/TaskDetailPanel'
import { CreateTaskModal, CreateEpicModal, CreateFeatureModal } from './CreateModals'
import { useTaskMutations } from './useTaskMutations'
import { usePlanWithAI } from './usePlanWithAI'
import { boardColumns, type RightPanel, type SimpleUser } from './task-config'

type View = 'tasks' | 'bugs' | 'my-tasks'

interface Props {
  initialTasks: Task[]
  initialEpics: Epic[]
  initialAgents: Agent[]
  initialUsers?: SimpleUser[]
  initialBugs?: Bug[]
}

const isOpen = (s: string) => s !== 'closed' && s !== 'resolved'
const isActive = (s: string) => s !== 'done' && s !== 'failed'

export function TasksPage({ initialTasks, initialEpics, initialAgents, initialUsers = [], initialBugs = [] }: Props) {
  const params = useSearchParams()
  const { data: session } = useSession()
  const currentUserId = session?.user?.id
  const [view, setView]             = useState<View>('tasks')
  const [selection, setSelection]   = useState<SelectionState>({ kind: 'all' })
  const [panel, setPanel]           = useState<RightPanel>(null)
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false)
  const [taskModal, setTaskModal]   = useState(false)
  const [epicModal, setEpicModal]   = useState(false)
  const [featureModal, setFeatureModal] = useState<{ epicId: string; epicTitle: string } | null>(null)

  const m = useTaskMutations({ initialTasks, initialEpics, initialAgents, setPanel, setSelection })
  const { tasks, epics, agents } = m
  const planWithAI = usePlanWithAI()

  // Open the right panel when navigated back from a planning chat
  useEffect(() => {
    const epicId    = params.get('epicId')
    const featureId = params.get('featureId')
    const taskId    = params.get('taskId')
    if (epicId) {
      const epic = initialEpics.find(e => e.id === epicId)
      if (epic) { setSelection({ kind: 'epic', epicId }); setPanel({ kind: 'epic', epic }) }
    } else if (featureId) {
      for (const epic of initialEpics) {
        const feature = epic.features.find(f => f.id === featureId)
        if (feature) { setSelection({ kind: 'feature', epicId: epic.id, featureId }); setPanel({ kind: 'feature', feature, epic }); break }
      }
    } else if (taskId) {
      const task = initialTasks.find(t => t.id === taskId)
      if (task) setPanel({ kind: 'task', task })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deep link is applied once on mount
  }, [])

  // ── Filtered tasks ─────────────────────────────────────────────────────────

  const visibleTasks = useMemo(() => {
    if (view === 'my-tasks') return currentUserId ? tasks.filter(t => t.assignedUserId === currentUserId) : []
    switch (selection.kind) {
      case 'all': return tasks
      case 'unassigned': return tasks.filter(t => !t.featureId)
      case 'epic': {
        const featureIds = new Set(epics.find(e => e.id === selection.epicId)?.features.map(f => f.id) ?? [])
        return tasks.filter(t => t.featureId && featureIds.has(t.featureId))
      }
      case 'feature': return tasks.filter(t => t.featureId === selection.featureId)
      default: return tasks
    }
  }, [tasks, epics, selection, view, currentUserId])

  const columns = useMemo(() => boardColumns(visibleTasks), [visibleTasks])
  const activeFeatureId = selection.kind === 'feature' ? selection.featureId : null
  const openBugs = initialBugs.filter(b => isOpen(b.status)).length
  const myOpenTasks = currentUserId ? tasks.filter(t => t.assignedUserId === currentUserId && isActive(t.status)).length : 0

  const openNewFeature = (epicId: string) => {
    const epic = epics.find(e => e.id === epicId)
    if (epic) setFeatureModal({ epicId, epicTitle: epic.title })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const viewTab = (id: View, children: React.ReactNode, extra = '') => (
    <button
      role="tab"
      aria-selected={view === id}
      onClick={() => setView(id)}
      className={`${extra} px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
        view === id
          ? 'bg-bg-raised border border-b-0 border-border-subtle text-text-primary'
          : 'text-text-muted hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">

      {/* Top: Tasks / Bugs / My Tasks tab bar */}
      <div role="tablist" aria-label="Task views" className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-border-subtle bg-bg-sidebar flex-shrink-0">
        {viewTab('tasks', 'Tasks')}
        {viewTab('bugs', <>
          Bugs
          {openBugs > 0 && (
            <span className="ml-1.5 px-1 py-0.5 text-[9px] rounded bg-status-error/20 text-status-error">{openBugs}</span>
          )}
        </>)}
        {viewTab('my-tasks', <>
          <User size={11} />
          My Tasks
          {myOpenTasks > 0 && (
            <span className="px-1 py-0.5 text-[9px] rounded bg-accent/20 text-accent">{myOpenTasks}</span>
          )}
        </>, 'flex items-center gap-1.5')}
      </div>

      {/* Bug view */}
      {view === 'bugs' && (
        <div className="flex-1 flex overflow-hidden">
          <BugManager initialBugs={initialBugs} users={initialUsers} />
        </div>
      )}

      {/* Tasks / My Tasks view — same Kanban layout, My Tasks filters to current user */}
      {(view === 'tasks' || view === 'my-tasks') && (
        <div className="flex-1 flex overflow-hidden">
          <EpicTreeSidebar
            epics={epics}
            tasks={tasks}
            selection={selection}
            onSelect={s => { setSelection(s); setPanel(null) }}
            onNewEpic={() => setEpicModal(true)}
            onNewFeature={openNewFeature}
            mobileOpen={mobileTreeOpen}
            onMobileClose={() => setMobileTreeOpen(false)}
          />

          {/* Center: Kanban */}
          <div className="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-4 lg:py-6">
            <TaskBoardToolbar
              view={view}
              selection={selection}
              epics={epics}
              totalCount={tasks.length}
              visibleCount={visibleTasks.length}
              onOpenTree={() => setMobileTreeOpen(true)}
              onViewEpic={epic => setPanel({ kind: 'epic', epic })}
              onViewFeature={(epic, featureId) => {
                const feature = epic.features.find(f => f.id === featureId)
                if (feature) setPanel({ kind: 'feature', feature, epic })
              }}
              onNewTask={() => setTaskModal(true)}
            />
            <TaskBoard
              columns={columns}
              tasks={visibleTasks}
              agents={agents}
              selectedTaskId={panel?.kind === 'task' ? panel.task.id : null}
              onToggleTask={task => setPanel(p => p?.kind === 'task' && p.task.id === task.id ? null : { kind: 'task', task })}
            />
          </div>
        </div>
      )}

      {/* ── Detail panel — rendered outside view blocks so it works from My Tasks too ── */}
      {panel && (
        <Dialog
          onClose={() => setPanel(null)}
          label={panel.kind === 'task' ? panel.task.title : panel.kind === 'epic' ? panel.epic.title : panel.feature.title}
          className="w-full flex justify-center"
          overlayClassName="backdrop-blur-none"
        >
          {panel.kind === 'epic' && (
            <EpicDetailPanel
              epic={panel.epic}
              onUpdate={patch => m.updateEpic(panel.epic.id, patch as Partial<Epic>)}
              onDelete={() => m.deleteEpic(panel.epic.id)}
              onPlanWithClaude={() => planWithAI({ type: 'epic', id: panel.epic.id, title: panel.epic.title, description: panel.epic.description })}
              onNewFeature={() => setFeatureModal({ epicId: panel.epic.id, epicTitle: panel.epic.title })}
              onSelectFeature={f => setPanel({ kind: 'feature', feature: f, epic: panel.epic })}
              onClose={() => setPanel(null)}
            />
          )}

          {panel.kind === 'feature' && (
            <FeatureDetailPanel
              feature={panel.feature}
              epicTitle={panel.epic.title}
              onUpdate={patch => m.updateFeature(panel.feature.id, panel.epic.id, patch)}
              onDelete={() => m.deleteFeature(panel.feature.id, panel.epic.id)}
              onPlanWithClaude={() => planWithAI({ type: 'feature', id: panel.feature.id, title: panel.feature.title, description: panel.feature.description, parentContext: { epicTitle: panel.epic.title, epicDescription: panel.epic.description, epicPlan: panel.epic.plan } })}
              onClose={() => setPanel(null)}
            />
          )}

          {panel.kind === 'task' && (
            <TaskDetailPanel
              task={panel.task}
              tasks={tasks}
              epics={epics}
              agents={agents}
              users={initialUsers}
              columns={columns}
              onClose={() => setPanel(null)}
              onUpdate={patch => m.updateTask(panel.task.id, patch)}
              onDelete={() => m.deleteTask(panel.task.id)}
              onPlan={planWithAI}
            />
          )}
        </Dialog>
      )}

      {taskModal && (
        <CreateTaskModal
          featureTitle={activeFeatureId ? (epics.flatMap(e => e.features).find(f => f.id === activeFeatureId)?.title ?? '') : undefined}
          onClose={() => setTaskModal(false)}
          onCreate={async form => {
            const task = await m.createTask({ ...form, featureId: activeFeatureId })
            if (!task) return
            setTaskModal(false)
            setPanel({ kind: 'task', task })
          }}
        />
      )}

      {epicModal && (
        <CreateEpicModal
          onClose={() => setEpicModal(false)}
          onCreate={async form => {
            const epic = await m.createEpic(form)
            if (!epic) return
            setEpicModal(false)
            setSelection({ kind: 'epic', epicId: epic.id })
            setPanel({ kind: 'epic', epic })
          }}
        />
      )}

      {featureModal && (
        <CreateFeatureModal
          epicTitle={featureModal.epicTitle}
          onClose={() => setFeatureModal(null)}
          onCreate={async form => {
            const feature = await m.createFeature({ ...form, epicId: featureModal.epicId })
            if (!feature) return
            setFeatureModal(null)
            const parentEpic = epics.find(e => e.id === feature.epicId)
            setSelection({ kind: 'feature', epicId: feature.epicId, featureId: feature.id })
            if (parentEpic) setPanel({ kind: 'feature', feature, epic: parentEpic })
          }}
        />
      )}
    </div>
  )
}
