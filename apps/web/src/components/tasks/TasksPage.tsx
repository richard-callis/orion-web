'use client'
import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus, X, Trash2, ChevronRight, Flag, Menu, Terminal, CheckCircle2, XCircle, Play, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react'
import type { Agent, Task, Feature, Epic, SelectionState, PlanTarget, Bug } from '@/types/tasks'
import { BugManager } from './BugManager'

interface TaskEvent {
  id: string
  taskId: string
  eventType: string
  content: string | null
  agentId: string | null
  createdAt: string
}


import { PlanWithAIButton } from './PlanWithAIButton'
import { EpicTreeNav } from './EpicTreeNav'
import { EpicDetailPanel } from './EpicDetailPanel'
import { FeatureDetailPanel } from './FeatureDetailPanel'
import { agentInitials } from './TeamDetailPanel'

const AGENT_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-emerald-500', 'bg-orange-500',
  'bg-pink-500', 'bg-cyan-500', 'bg-yellow-500', 'bg-red-500',
]

// ── Constants ─────────────────────────────────────────────────────────────────

const COLUMNS = ['pending', 'in_progress', 'done', 'failed'] as const
type Status = typeof COLUMNS[number]

const colLabel: Record<Status, string> = { pending: 'Backlog', in_progress: 'In Progress', done: 'Done', failed: 'Failed' }
const colTopBorder: Record<Status, string> = {
  pending: 'border-t-border-visible', in_progress: 'border-t-accent',
  done: 'border-t-status-healthy', failed: 'border-t-status-error',
}
const priorityConfig: Record<string, { label: string; color: string; dot: string }> = {
  critical: { label: 'Critical', color: 'text-status-error',   dot: 'bg-status-error'   },
  high:     { label: 'High',     color: 'text-status-warning', dot: 'bg-status-warning' },
  medium:   { label: 'Medium',   color: 'text-accent',         dot: 'bg-accent'         },
  low:      { label: 'Low',      color: 'text-text-muted',     dot: 'bg-border-visible' },
}

// ── Types ─────────────────────────────────────────────────────────────────────

type RightPanel =
  | null
  | { kind: 'task';    task: Task }
  | { kind: 'epic';    epic: Epic }
  | { kind: 'feature'; feature: Feature; epic: Epic }

interface CreateTaskForm { title: string; description: string; priority: string }
interface CreateEpicForm { title: string; description: string }
interface CreateFeatureForm { title: string; description: string; epicId: string; epicTitle: string }

interface PlanningConvo {
  id: string
  title: string | null
  metadata: { planTarget: { type: string; id: string } }
  updatedAt: string
}

interface SimpleUser { id: string; name: string | null; username: string; email: string; role: string }

interface Props {
  initialTasks: Task[]
  initialEpics: Epic[]
  initialAgents: Agent[]
  initialUsers?: SimpleUser[]
  initialPlanningConvos?: PlanningConvo[]
  initialBugs?: Bug[]
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TasksPage({ initialTasks, initialEpics, initialAgents, initialUsers = [], initialPlanningConvos = [], initialBugs = [] }: Props) {
  const router = useRouter()
  const params = useSearchParams()
  const [tasks, setTasks]       = useState<Task[]>(initialTasks)
  const [epics, setEpics]       = useState<Epic[]>(initialEpics)
  const [agents, setAgents]     = useState<Agent[]>(initialAgents)
  const [users]                 = useState<SimpleUser[]>(initialUsers)
  const [view, setView]         = useState<'tasks' | 'bugs'>('tasks')
  const [selection, setSelection] = useState<SelectionState>({ kind: 'all' })
  const [panel, setPanel]       = useState<RightPanel>(null)
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false)

  // Open the right panel when navigated back from a planning chat
  useEffect(() => {
    const epicId   = params.get('epicId')
    const featureId = params.get('featureId')
    const taskId   = params.get('taskId')
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
  }, [])

  // Create modal state
  const [taskModal, setTaskModal]       = useState(false)
  const [epicModal, setEpicModal]       = useState(false)
  const [featureModal, setFeatureModal] = useState<{ epicId: string; epicTitle: string } | null>(null)
  const [taskForm, setTaskForm]         = useState<CreateTaskForm>({ title: '', description: '', priority: 'medium' })
  const [epicForm, setEpicForm]         = useState<CreateEpicForm>({ title: '', description: '' })
  const [featureForm, setFeatureForm]   = useState<CreateFeatureForm>({ title: '', description: '', epicId: '', epicTitle: '' })
  const [saving, setSaving]             = useState(false)

  // Task detail edit state
  const [editTitle, setEditTitle]       = useState('')
  const [editDesc, setEditDesc]         = useState('')
  const [editPlan, setEditPlan]         = useState('')
  const [editPriority, setEditPriority] = useState('medium')
  const titleRef = useRef<HTMLInputElement>(null)

  // Task log tab
  const [taskTab, setTaskTab]           = useState<'details' | 'log'>('details')
  const [taskEvents, setTaskEvents]     = useState<TaskEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set())

  const loadEvents = useCallback(async (taskId: string) => {
    setEventsLoading(true)
    try {
      const res = await fetch(`/api/tasks/${taskId}/events`)
      if (res.ok) setTaskEvents(await res.json())
    } finally {
      setEventsLoading(false)
    }
  }, [])


  // Sync task detail panel when task changes
  useEffect(() => {
    if (panel?.kind === 'task') {
      setEditTitle(panel.task.title)
      setEditDesc(panel.task.description ?? '')
      setEditPlan(panel.task.plan ?? '')
      setEditPriority(panel.task.priority)
      setTaskTab('details')
      setTaskEvents([])
      setExpandedEvents(new Set())
    }
  }, [panel?.kind === 'task' ? panel.task.id : null])

  // ── Filtered tasks ─────────────────────────────────────────────────────────

  const visibleTasks = useMemo(() => {
    switch (selection.kind) {
      case 'all': return tasks
      case 'unassigned': return tasks.filter(t => !t.featureId)
      case 'epic': {
        const featureIds = new Set(
          epics.find(e => e.id === selection.epicId)?.features.map(f => f.id) ?? []
        )
        return tasks.filter(t => t.featureId && featureIds.has(t.featureId))
      }
      case 'feature': return tasks.filter(t => t.featureId === selection.featureId)
    }
  }, [tasks, epics, selection])

  const byStatus = (s: Status) => visibleTasks.filter(t => t.status === s)

  // ── Feature id when creating a task ───────────────────────────────────────

  const activeFeatureId = selection.kind === 'feature' ? selection.featureId : null

  // ── Task CRUD ──────────────────────────────────────────────────────────────

  const updateTask = async (id: string, patch: Partial<Task>) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
    if (panel?.kind === 'task' && panel.task.id === id)
      setPanel(p => p?.kind === 'task' ? { ...p, task: { ...p.task, ...patch } } : p)
    await fetch(`/api/tasks/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).catch(() => {})
  }

  const deleteTask = async (id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id))
    if (panel?.kind === 'task' && panel.task.id === id) setPanel(null)
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  const createTask = async () => {
    if (!taskForm.title.trim()) return
    setSaving(true)
    const r = await fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: taskForm.title, description: taskForm.description || null,
        priority: taskForm.priority, featureId: activeFeatureId, createdBy: 'admin',
      }),
    })
    const task: Task = await r.json()
    setTasks(prev => [task, ...prev])
    // Bump feature task count
    if (task.featureId) {
      setEpics(prev => prev.map(e => ({
        ...e,
        features: e.features.map(f =>
          f.id === task.featureId ? { ...f, _count: { tasks: (f._count?.tasks ?? 0) + 1 } } : f
        ),
      })))
    }
    setTaskForm({ title: '', description: '', priority: 'medium' })
    setTaskModal(false)
    setSaving(false)
    setPanel({ kind: 'task', task })
  }

  const saveTaskDetail = async () => {
    if (panel?.kind !== 'task') return
    await updateTask(panel.task.id, { title: editTitle, description: editDesc || null, priority: editPriority })
  }

  const saveTaskPlan = async () => {
    if (panel?.kind !== 'task') return
    await updateTask(panel.task.id, { plan: editPlan || null })
  }

  // ── Epic CRUD ──────────────────────────────────────────────────────────────

  const updateEpic = async (id: string, patch: Partial<Epic>) => {
    setEpics(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e))
    if (panel?.kind === 'epic' && panel.epic.id === id)
      setPanel(p => p?.kind === 'epic' ? { ...p, epic: { ...p.epic, ...patch } } : p)
    await fetch(`/api/epics/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).catch(() => {})
  }

  const deleteEpic = async (id: string) => {
    setEpics(prev => prev.filter(e => e.id !== id))
    setSelection({ kind: 'all' })
    setPanel(null)
    await fetch(`/api/epics/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  const createEpic = async () => {
    if (!epicForm.title.trim()) return
    setSaving(true)
    const r = await fetch('/api/epics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: epicForm.title, description: epicForm.description || null }),
    })
    const epic: Epic = await r.json()
    setEpics(prev => [epic, ...prev])
    setEpicForm({ title: '', description: '' })
    setEpicModal(false)
    setSaving(false)
    setSelection({ kind: 'epic', epicId: epic.id })
    setPanel({ kind: 'epic', epic })
  }

  // ── Feature CRUD ───────────────────────────────────────────────────────────

  const updateFeature = async (id: string, epicId: string, patch: Partial<Feature>) => {
    setEpics(prev => prev.map(e =>
      e.id === epicId
        ? { ...e, features: e.features.map(f => f.id === id ? { ...f, ...patch } : f) }
        : e
    ))
    if (panel?.kind === 'feature' && panel.feature.id === id)
      setPanel(p => p?.kind === 'feature' ? { ...p, feature: { ...p.feature, ...patch } } : p)
    await fetch(`/api/features/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).catch(() => {})
  }

  const deleteFeature = async (id: string, epicId: string) => {
    setEpics(prev => prev.map(e =>
      e.id === epicId ? { ...e, features: e.features.filter(f => f.id !== id) } : e
    ))
    setSelection({ kind: 'epic', epicId })
    setPanel(null)
    await fetch(`/api/features/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  const createFeature = async () => {
    if (!featureForm.title.trim()) return
    setSaving(true)
    const r = await fetch('/api/features', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epicId: featureForm.epicId, title: featureForm.title, description: featureForm.description || null }),
    })
    const feature: Feature = await r.json()
    setEpics(prev => prev.map(e =>
      e.id === featureForm.epicId ? { ...e, features: [...e.features, feature] } : e
    ))
    setFeatureForm({ title: '', description: '', epicId: '', epicTitle: '' })
    setFeatureModal(null)
    setSaving(false)
    const parentEpic = epics.find(e => e.id === feature.epicId)!
    setSelection({ kind: 'feature', epicId: feature.epicId, featureId: feature.id })
    setPanel({ kind: 'feature', feature, epic: parentEpic })
  }

  // ── Agent CRUD ─────────────────────────────────────────────────────────────

  const createAgent = (agent: Agent) => setAgents(prev => [...prev, agent])

  const updateAgent = async (id: string, patch: Partial<Agent>) => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a))
    await fetch(`/api/agents/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }).catch(() => {})
  }

  const deleteAgent = async (id: string) => {
    setAgents(prev => prev.filter(a => a.id !== id))
    // Clear assignment from tasks
    setTasks(prev => prev.map(t => t.assignedAgent === id ? { ...t, assignedAgent: null, agent: null } : t))
    await fetch(`/api/agents/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  // ── Plan with AI ───────────────────────────────────────────────────────────

  const planWithClaude = async (target: PlanTarget, modelId = 'claude') => {
    const prefix =
      target.type === 'epic'    ? '◆ EPIC · ' :
      target.type === 'feature' ? '▸ FEAT · ' :
                                  '● TASK · '

    const promptKey = target.type === 'epic' ? 'context.epic-plan'
      : target.type === 'feature' ? 'context.feature-plan' : 'context.task-plan'
    const tmplRes = await fetch(`/api/admin/prompts/${encodeURIComponent(promptKey)}`)
    let initialContext = ''
    if (tmplRes.ok) {
      const { content } = await tmplRes.json() as { content: string }
      initialContext = content
        .replace(/\{\{title\}\}/g, target.title)
        .replace(/\{\{description\}\}/g, target.description ?? 'No description yet.')
    } else {
      initialContext = target.type === 'epic'
        ? `I want to design a high-level plan for this epic:\n\n**${target.title}**\n\n${target.description ?? 'No description yet.'}\n\nHelp me break this down into features and an implementation strategy.`
        : target.type === 'feature'
        ? `I want to plan this feature:\n\n**${target.title}**\n\n${target.description ?? 'No description yet.'}\n\nHelp me break it down into specific tasks and implementation details.`
        : `I want to plan this task:\n\n**${target.title}**\n\n${target.description ?? 'No description yet.'}\n\nHelp me break this down into a clear implementation plan.`
    }

    const r = await fetch('/api/chat/conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `${prefix}${target.title}`,
        initialContext,
        planTarget: { type: target.type, id: target.id },
        planModel: modelId,
      }),
    })
    const convo = await r.json()
    router.push(`/chat?conversation=${convo.id}`)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">

      {/* Top: Tasks / Bugs tab bar */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-border-subtle bg-bg-sidebar flex-shrink-0">
        <button
          onClick={() => setView('tasks')}
          className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
            view === 'tasks'
              ? 'bg-bg-raised border border-b-0 border-border-subtle text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          Tasks
        </button>
        <button
          onClick={() => setView('bugs')}
          className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
            view === 'bugs'
              ? 'bg-bg-raised border border-b-0 border-border-subtle text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          Bugs
          {initialBugs.filter(b => b.status !== 'closed' && b.status !== 'resolved').length > 0 && (
            <span className="ml-1.5 px-1 py-0.5 text-[9px] rounded bg-status-error/20 text-status-error">
              {initialBugs.filter(b => b.status !== 'closed' && b.status !== 'resolved').length}
            </span>
          )}
        </button>
      </div>

      {/* Bug view */}
      {view === 'bugs' && (
        <div className="flex-1 flex overflow-hidden">
          <BugManager initialBugs={initialBugs} users={users} />
        </div>
      )}

      {/* Tasks view */}
      {view === 'tasks' && <div className="flex-1 flex overflow-hidden">

      {/* Left: Epic tree — desktop only */}
      <div className="hidden md:flex">
        <EpicTreeNav
          epics={epics}
          tasks={tasks}
          selection={selection}
          onSelect={s => { setSelection(s); setPanel(null) }}
          onNewEpic={() => setEpicModal(true)}
          onNewFeature={epicId => {
            const epic = epics.find(e => e.id === epicId)!
            setFeatureForm({ title: '', description: '', epicId, epicTitle: epic.title })
            setFeatureModal({ epicId, epicTitle: epic.title })
          }}
        />
      </div>

      {/* Mobile: Epic tree overlay */}
      {mobileTreeOpen && (
        <div className="md:hidden absolute inset-0 z-50 flex">
          <EpicTreeNav
            epics={epics}
            tasks={tasks}
            selection={selection}
            onSelect={s => { setSelection(s); setPanel(null); setMobileTreeOpen(false) }}
            onNewEpic={() => { setEpicModal(true); setMobileTreeOpen(false) }}
            onNewFeature={epicId => {
              const epic = epics.find(e => e.id === epicId)!
              setFeatureForm({ title: '', description: '', epicId, epicTitle: epic.title })
              setFeatureModal({ epicId, epicTitle: epic.title })
              setMobileTreeOpen(false)
            }}
          />
          <div className="flex-1 bg-black/60" onClick={() => setMobileTreeOpen(false)} />
        </div>
      )}

      {/* Center: Kanban */}
      <div className="flex-1 flex flex-col overflow-hidden px-4 lg:px-6 py-4 lg:py-6">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            {/* Mobile: open epic tree */}
            <button
              onClick={() => setMobileTreeOpen(true)}
              className="md:hidden p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
              title="Browse epics"
            >
              <Menu size={16} />
            </button>
            <h1 className="text-sm font-semibold text-text-secondary">
              {selection.kind === 'all'        && `All Tasks (${tasks.length})`}
              {selection.kind === 'unassigned' && `Unassigned Tasks (${visibleTasks.length})`}
              {selection.kind === 'epic'       && `${epics.find(e => e.id === selection.epicId)?.title ?? 'Epic'} (${visibleTasks.length})`}
              {selection.kind === 'feature'    && (() => {
                const epic = epics.find(e => e.id === (selection as { epicId: string }).epicId)
                const feat = epic?.features.find(f => f.id === (selection as { featureId: string }).featureId)
                return `${feat?.title ?? 'Feature'} (${visibleTasks.length})`
              })()}
            </h1>
            {/* Show epic/feature detail button */}
            {selection.kind === 'epic' && (
              <button
                onClick={() => {
                  const epic = epics.find(e => e.id === (selection as { epicId: string }).epicId)
                  if (epic) setPanel({ kind: 'epic', epic })
                }}
                className="text-[10px] text-accent hover:underline"
              >
                View Epic →
              </button>
            )}
            {selection.kind === 'feature' && (
              <button
                onClick={() => {
                  const sel = selection as { epicId: string; featureId: string }
                  const epic = epics.find(e => e.id === sel.epicId)
                  const feature = epic?.features.find(f => f.id === sel.featureId)
                  if (epic && feature) setPanel({ kind: 'feature', feature, epic })
                }}
                className="text-[10px] text-accent hover:underline"
              >
                View Feature →
              </button>
            )}
          </div>
          <button
            onClick={() => setTaskModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent/80 transition-colors"
          >
            <Plus size={14} /> New Task
          </button>
        </div>

        {/* Board */}
        <div className="flex gap-3 flex-1 overflow-x-auto overflow-y-hidden">
          {COLUMNS.map(col => (
            <div key={col} className={`flex-shrink-0 w-60 flex flex-col rounded-lg border border-border-subtle bg-bg-card border-t-2 ${colTopBorder[col]}`}>
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-subtle">
                <span className="text-xs font-semibold text-text-secondary">{colLabel[col]}</span>
                <span className="text-xs text-text-muted bg-bg-raised px-1.5 py-0.5 rounded">{byStatus(col).length}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {byStatus(col).map(task => {
                  const p = priorityConfig[task.priority] ?? priorityConfig.medium
                  const isSelected = panel?.kind === 'task' && panel.task.id === task.id
                  return (
                    <div
                      key={task.id}
                      onClick={() => setPanel(isSelected ? null : { kind: 'task', task })}
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
                        <div className="ml-auto flex items-center gap-1">
                          {task.plan && <span className="text-[10px] text-accent">has plan</span>}
                          {task.agent && (() => {
                            const idx = agents.findIndex(a => a.id === task.agent!.id)
                            return (
                              <div
                                title={task.agent.name}
                                className={`w-4 h-4 rounded-full ${AGENT_COLORS[idx >= 0 ? idx % AGENT_COLORS.length : 0]} flex items-center justify-center`}
                              >
                                <span className="text-[7px] font-bold text-white">{agentInitials(task.agent.name)}</span>
                              </div>
                            )
                          })()}
                        </div>
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

      {/* Right: Detail panel (modal) */}
      {panel && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => setPanel(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
          <div className="pointer-events-auto w-full flex justify-center">
            {panel.kind === 'epic' && (
              <EpicDetailPanel
                epic={panel.epic}
                onUpdate={patch => updateEpic(panel.epic.id, patch as Partial<Epic>)}
                onDelete={() => deleteEpic(panel.epic.id)}
                onPlanWithClaude={(modelId) => planWithClaude({ type: 'epic', id: panel.epic.id, title: panel.epic.title, description: panel.epic.description }, modelId)}
                onGenerateFeatures={async () => {
                  const r = await fetch(`/api/epics/${panel.epic.id}/generate-features`, { method: 'POST' })
                  if (!r.ok) {
                    const body = await r.json().catch(() => ({}))
                    throw new Error(body.error ?? `HTTP ${r.status}`)
                  }
                  const { features } = await r.json()
                  setEpics(prev => prev.map(e =>
                    e.id === panel.epic.id ? { ...e, features: [...e.features, ...features] } : e
                  ))
                  setPanel(null)
                }}
                onNewFeature={() => {
                  setFeatureForm({ title: '', description: '', epicId: panel.epic.id, epicTitle: panel.epic.title })
                  setFeatureModal({ epicId: panel.epic.id, epicTitle: panel.epic.title })
                }}
                onSelectFeature={f => setPanel({ kind: 'feature', feature: f, epic: panel.epic })}
                onClose={() => setPanel(null)}
              />
            )}

            {panel.kind === 'feature' && (
              <FeatureDetailPanel
                feature={panel.feature}
                epicTitle={panel.epic.title}
                onUpdate={patch => updateFeature(panel.feature.id, panel.epic.id, patch as Partial<Feature>)}
                onDelete={() => deleteFeature(panel.feature.id, panel.epic.id)}
                onPlanWithClaude={(modelId) => planWithClaude({ type: 'feature', id: panel.feature.id, title: panel.feature.title, description: panel.feature.description }, modelId)}
                onGenerateTasks={async () => {
                  const r = await fetch(`/api/features/${panel.feature.id}/generate-tasks`, { method: 'POST' })
                  if (!r.ok) {
                    const body = await r.json().catch(() => ({}))
                    throw new Error(body.error ?? `HTTP ${r.status}`)
                  }
                  const { tasks: newTasks } = await r.json()
                  setTasks(prev => [...newTasks, ...prev])
                  // Bump task count on the feature
                  setEpics(prev => prev.map(e =>
                    e.id === panel.epic.id
                      ? { ...e, features: e.features.map(f =>
                          f.id === panel.feature.id
                            ? { ...f, _count: { tasks: (f._count?.tasks ?? 0) + newTasks.length } }
                            : f
                        )}
                      : e
                  ))
                  setPanel(null)
                }}
                onClose={() => setPanel(null)}
              />
            )}

            {panel.kind === 'task' && (
        <aside className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-xl border border-border-subtle bg-bg-sidebar shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <span className="text-xs font-semibold text-text-secondary">Task Detail</span>
            <button onClick={() => setPanel(null)} className="text-text-muted hover:text-text-primary"><X size={14} /></button>
          </div>
          {/* Tabs */}
          <div className="flex border-b border-border-subtle px-4">
            <button onClick={() => setTaskTab('details')}
              className={`px-3 py-2 text-[11px] font-medium border-b-2 transition-colors ${taskTab === 'details' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-secondary'}`}>
              Details
            </button>
            <button onClick={() => { setTaskTab('log'); loadEvents(panel.task.id) }}
              className={`px-3 py-2 text-[11px] font-medium border-b-2 transition-colors ${taskTab === 'log' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-secondary'}`}>
              Run Log
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {taskTab === 'details' && (<>
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Title</label>
              <input ref={titleRef} value={editTitle} onChange={e => setEditTitle(e.target.value)} onBlur={saveTaskDetail}
                className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Priority</label>
              <select value={editPriority} onChange={e => { setEditPriority(e.target.value); updateTask(panel.task.id, { priority: e.target.value }) }}
                className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent">
                {Object.entries(priorityConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Assigned To (Agent)</label>
              <select
                value={panel.task.assignedAgent ?? ''}
                onChange={e => {
                  const agentId = e.target.value || null
                  const agent = agents.find(a => a.id === agentId) ?? null
                  updateTask(panel.task.id, { assignedAgent: agentId, agent })
                }}
                className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
              >
                <option value="">— No agent —</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.role ? ` (${a.role})` : ''}</option>)}
              </select>
            </div>
            {users.length > 0 && (
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Assigned To (User)</label>
                <select
                  value={panel.task.assignedUserId ?? ''}
                  onChange={e => {
                    const userId = e.target.value || null
                    const assignedUser = users.find(u => u.id === userId) ?? null
                    updateTask(panel.task.id, { assignedUserId: userId, assignedUser })
                  }}
                  className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
                >
                  <option value="">— No user —</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name ?? u.username}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Status</label>
              <div className="grid grid-cols-2 gap-1.5">
                {COLUMNS.map(col => (
                  <button key={col} onClick={() => updateTask(panel.task.id, { status: col })}
                    className={`px-2 py-1.5 rounded text-[10px] font-medium transition-colors ${
                      panel.task.status === col ? 'bg-accent text-white' : 'bg-bg-raised text-text-muted hover:text-text-primary hover:bg-bg-card border border-border-subtle'
                    }`}>
                    {colLabel[col]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Your Description</label>
              <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} onBlur={saveTaskDetail} rows={4}
                placeholder="What needs to be done, context, requirements..."
                className="w-full px-2.5 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed" />
            </div>
            <div>
              <label className="text-[10px] text-accent uppercase tracking-wide mb-1 block">Claude&apos;s Plan</label>
              <textarea value={editPlan} onChange={e => setEditPlan(e.target.value)} onBlur={saveTaskPlan} rows={6}
                placeholder="No plan yet — use 'Plan with AI' to generate one..."
                className="w-full px-2.5 py-1.5 text-sm rounded border border-accent/30 bg-accent/5 text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed" />
            </div>
            <p className="text-[10px] text-text-muted">Created {new Date(panel.task.createdAt).toLocaleDateString()}</p>
            </>)}

            {taskTab === 'log' && (
              <TaskRunLog events={taskEvents} loading={eventsLoading} agents={agents}
                expanded={expandedEvents} onToggle={id => setExpandedEvents(prev => {
                  const next = new Set(prev)
                  next.has(id) ? next.delete(id) : next.add(id)
                  return next
                })}
                onRefresh={() => loadEvents(panel.task.id)} />
            )}
          </div>
          {taskTab === 'details' && (
          <div className="p-3 border-t border-border-subtle space-y-2">
            <PlanWithAIButton onSelect={modelId => planWithClaude({ type: 'task', id: panel.task.id, title: panel.task.title, description: panel.task.description }, modelId)} />
            <button onClick={() => deleteTask(panel.task.id)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-border-subtle text-text-muted text-sm hover:border-status-error hover:text-status-error transition-colors">
              <Trash2 size={14} /> Delete Task
            </button>
          </div>
          )}
        </aside>
            )}
          </div>
          </div>
        </>
      )}

      </div>}
      {/* end tasks view */}

      {/* ── Modals ────────────────────────────────────────────────────────── */}

      {/* Create Task */}
      {taskModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setTaskModal(false)}>
          <div className="bg-bg-card border border-border-visible rounded-xl p-6 w-[480px] max-w-[90vw] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-text-primary">New Task</h2>
                {activeFeatureId && (
                  <p className="text-[10px] text-accent mt-0.5">
                    Adding to: {epics.flatMap(e => e.features).find(f => f.id === activeFeatureId)?.title}
                  </p>
                )}
              </div>
              <button onClick={() => setTaskModal(false)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Title *</label>
                <input autoFocus value={taskForm.title} onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && createTask()}
                  placeholder="What needs to be done?"
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Your Description</label>
                <textarea value={taskForm.description} onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))} rows={3}
                  placeholder="Context, goals, requirements..."
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Priority</label>
                <div className="flex gap-2">
                  {Object.entries(priorityConfig).map(([k, v]) => (
                    <button key={k} onClick={() => setTaskForm(f => ({ ...f, priority: k }))}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs border transition-colors ${
                        taskForm.priority === k ? 'border-accent bg-accent/15 text-accent' : 'border-border-subtle text-text-muted hover:border-border-visible'
                      }`}>
                      <Flag size={10} />{v.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setTaskModal(false)} className="px-4 py-2 text-sm text-text-muted hover:text-text-primary">Cancel</button>
              <button onClick={createTask} disabled={!taskForm.title.trim() || saving}
                className="px-4 py-2 text-sm rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {saving ? 'Creating…' : 'Create Task'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Epic */}
      {epicModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setEpicModal(false)}>
          <div className="bg-bg-card border border-border-visible rounded-xl p-6 w-[480px] max-w-[90vw] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-text-primary">New Epic</h2>
              <button onClick={() => setEpicModal(false)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Title *</label>
                <input autoFocus value={epicForm.title} onChange={e => setEpicForm(f => ({ ...f, title: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && createEpic()}
                  placeholder="What is this initiative about?"
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Description</label>
                <textarea value={epicForm.description} onChange={e => setEpicForm(f => ({ ...f, description: e.target.value }))} rows={3}
                  placeholder="High-level goals and scope..."
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEpicModal(false)} className="px-4 py-2 text-sm text-text-muted hover:text-text-primary">Cancel</button>
              <button onClick={createEpic} disabled={!epicForm.title.trim() || saving}
                className="px-4 py-2 text-sm rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {saving ? 'Creating…' : 'Create Epic'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Feature */}
      {featureModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setFeatureModal(null)}>
          <div className="bg-bg-card border border-border-visible rounded-xl p-6 w-[480px] max-w-[90vw] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-text-primary">New Feature</h2>
                <p className="text-[10px] text-text-muted mt-0.5">Under: {featureModal.epicTitle}</p>
              </div>
              <button onClick={() => setFeatureModal(null)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Title *</label>
                <input autoFocus value={featureForm.title} onChange={e => setFeatureForm(f => ({ ...f, title: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && createFeature()}
                  placeholder="What does this feature deliver?"
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide mb-1 block">Description</label>
                <textarea value={featureForm.description} onChange={e => setFeatureForm(f => ({ ...f, description: e.target.value }))} rows={3}
                  placeholder="Scope, acceptance criteria..."
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none leading-relaxed" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setFeatureModal(null)} className="px-4 py-2 text-sm text-text-muted hover:text-text-primary">Cancel</button>
              <button onClick={createFeature} disabled={!featureForm.title.trim() || saving}
                className="px-4 py-2 text-sm rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {saving ? 'Creating…' : 'Create Feature'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── TaskRunLog ─────────────────────────────────────────────────────────────────

const EVENT_ICONS: Record<string, React.ReactNode> = {
  started:     <Play size={11} className="text-accent" />,
  completed:   <CheckCircle2 size={11} className="text-status-healthy" />,
  failed:      <XCircle size={11} className="text-status-error" />,
  tool_call:   <Terminal size={11} className="text-status-warning" />,
  tool_result: <Terminal size={11} className="text-text-muted" />,
  comment:     <MessageSquare size={11} className="text-text-muted" />,
}

const EVENT_LABEL: Record<string, string> = {
  started:     'Started',
  completed:   'Completed',
  failed:      'Failed',
  tool_call:   'Command',
  tool_result: 'Output',
  comment:     'Comment',
}

const EVENT_BG: Record<string, string> = {
  started:     'border-accent/30 bg-accent/5',
  completed:   'border-status-healthy/30 bg-status-healthy/5',
  failed:      'border-status-error/30 bg-status-error/5',
  tool_call:   'border-status-warning/20 bg-status-warning/5',
  tool_result: 'border-border-subtle bg-bg-raised',
  comment:     'border-border-subtle bg-bg-card',
}

function TaskRunLog({
  events, loading, agents, expanded, onToggle, onRefresh
}: {
  events: TaskEvent[]
  loading: boolean
  agents: Agent[]
  expanded: Set<string>
  onToggle: (id: string) => void
  onRefresh: () => void
}) {
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])

  if (loading) return (
    <div className="flex items-center justify-center py-12 text-text-muted text-xs">Loading…</div>
  )

  if (events.length === 0) return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <Terminal size={28} className="text-text-muted opacity-40" />
      <p className="text-xs text-text-muted">No run log yet.</p>
      <p className="text-[10px] text-text-muted opacity-60">Events will appear here once an agent runs this task.</p>
      <button onClick={onRefresh} className="text-[10px] text-accent hover:underline mt-1">Refresh</button>
    </div>
  )

  return (
    <div className="space-y-0">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-text-muted">{events.length} event{events.length !== 1 ? 's' : ''}</span>
        <button onClick={onRefresh} className="text-[10px] text-accent hover:underline">Refresh</button>
      </div>
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border-subtle" />
        <div className="space-y-2">
          {events.map(ev => {
            const isLong = (ev.content?.length ?? 0) > 200
            const isExpanded = expanded.has(ev.id)
            const displayContent = isLong && !isExpanded
              ? ev.content!.slice(0, 200) + '…'
              : ev.content
            const agent = ev.agentId ? agentMap.get(ev.agentId) : null

            return (
              <div key={ev.id} className="flex gap-3 pl-1">
                {/* Dot */}
                <div className="flex-shrink-0 w-3.5 h-3.5 mt-0.5 rounded-full bg-bg-sidebar border border-border-visible flex items-center justify-center z-10">
                  {EVENT_ICONS[ev.eventType] ?? <div className="w-1.5 h-1.5 rounded-full bg-border-visible" />}
                </div>
                {/* Card */}
                <div className={`flex-1 min-w-0 rounded border px-2.5 py-1.5 ${EVENT_BG[ev.eventType] ?? 'border-border-subtle bg-bg-raised'}`}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[10px] font-semibold text-text-secondary">
                      {EVENT_LABEL[ev.eventType] ?? ev.eventType}
                    </span>
                    {agent && (
                      <span className="text-[9px] text-text-muted">· {agent.name}</span>
                    )}
                    <span className="ml-auto text-[9px] text-text-muted flex-shrink-0">
                      {new Date(ev.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  {displayContent && (
                    <pre className="text-[11px] text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">{displayContent}</pre>
                  )}
                  {isLong && (
                    <button onClick={() => onToggle(ev.id)}
                      className="flex items-center gap-1 text-[10px] text-accent hover:underline mt-1">
                      {isExpanded ? <><ChevronUp size={10} /> Show less</> : <><ChevronDown size={10} /> Show more</>}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
