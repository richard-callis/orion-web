'use client'
import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { Plus, X, Trash2, ChevronRight, Flag, Menu, Terminal, CheckCircle2, XCircle, Play, MessageSquare, ChevronDown, ChevronUp, Send, Loader2, User } from 'lucide-react'
import type { Agent, Task, Feature, Epic, SelectionState, PlanTarget, Bug } from '@/types/tasks'
import { BugManager } from './BugManager'
import { KanbanBoard } from '../ui/KanbanBoard'
import { CreateEntityModal } from '../ui/CreateEntityModal'

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

// Known status config — label + top-border colour. Any status not listed here
// gets a sensible default so new statuses appear automatically without code changes.
const STATUS_CONFIG: Record<string, { label: string; border: string }> = {
  pending:            { label: 'Backlog',        border: 'border-t-border-visible' },
  in_progress:        { label: 'In Progress',    border: 'border-t-accent' },
  pending_validation: { label: 'Waiting for QA', border: 'border-t-status-warning' },
  done:               { label: 'Done',           border: 'border-t-status-healthy' },
  failed:             { label: 'Failed',         border: 'border-t-status-error' },
  critical:           { label: 'Critical',       border: 'border-t-status-error' },
}

// Preferred display order — known statuses first, unknowns appended after.
const STATUS_ORDER = ['pending', 'in_progress', 'pending_validation', 'done', 'failed', 'critical']

type Status = string
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
  const { data: session } = useSession()
  const currentUserId = (session?.user as any)?.id as string | undefined
  const [tasks, setTasks]       = useState<Task[]>(initialTasks)
  const [epics, setEpics]       = useState<Epic[]>(initialEpics)
  const [agents, setAgents]     = useState<Agent[]>(initialAgents)
  const activeAgents = agents.filter(a => !(a.metadata as Record<string,unknown> | null)?.archived)
  const [users]                 = useState<SimpleUser[]>(initialUsers)
  const [view, setView]         = useState<'tasks' | 'bugs' | 'my-tasks'>('tasks')
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
  const [taskTab, setTaskTab]           = useState<'details' | 'log' | 'chat'>('details')
  const [taskEvents, setTaskEvents]     = useState<TaskEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set())

  // Task chat tab
  interface ChatMsg {
    id: string
    senderType: string
    content: string
    sender: { type: string; id: string | null; name: string }
    createdAt: string
  }
  interface ChatRoom {
    id: string
    name: string
    type: string
    messages: ChatMsg[]
    members: Array<{ agentId: string | null; userId: string | null; agent: { id: string; name: string } | null; user: { id: string; name: string } | null }>
  }
  const [taskChatRooms, setTaskChatRooms]   = useState<ChatRoom[]>([])
  const [chatLoading, setChatLoading]       = useState(false)
  const [chatInput, setChatInput]           = useState('')
  const [chatSending, setChatSending]       = useState(false)
  const [activeChatRoom, setActiveChatRoom] = useState<string | null>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)

  const loadEvents = useCallback(async (taskId: string) => {
    setEventsLoading(true)
    try {
      const res = await fetch(`/api/tasks/${taskId}/events`)
      if (res.ok) setTaskEvents(await res.json())
    } finally {
      setEventsLoading(false)
    }
  }, [])

  const loadChat = useCallback(async (taskId: string) => {
    setChatLoading(true)
    try {
      const res = await fetch(`/api/tasks/${taskId}/chat`)
      if (res.ok) {
        const data = await res.json()
        setTaskChatRooms(data.rooms || [])
        if (data.rooms?.length && !activeChatRoom) {
          setActiveChatRoom(data.rooms[0].id)
        }
      }
    } finally {
      setChatLoading(false)
    }
  }, [activeChatRoom])

  const sendChatMessage = async () => {
    const content = chatInput.trim()
    if (!content || chatSending || !activeChatRoom || panel?.kind !== 'task') return
    setChatSending(true)
    setChatInput('')
    try {
      const res = await fetch(`/api/chatrooms/${activeChatRoom}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, taskId: panel.task.id }),
      })
      if (res.ok) {
        // Refresh room messages
        const roomRes = await fetch(`/api/tasks/${panel.task.id}/chat`)
        if (roomRes.ok) {
          const data = await roomRes.json()
          setTaskChatRooms(data.rooms || [])
        }
      }
    } catch (e) {
      console.error('Failed to send message:', e)
    } finally {
      setChatSending(false)
    }
  }


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
      setTaskChatRooms([])
      setActiveChatRoom(null)
      setChatInput('')
    }
  }, [panel?.kind === 'task' ? panel.task.id : null])

  // ── Filtered tasks ─────────────────────────────────────────────────────────

  const visibleTasks = useMemo(() => {
    let base: Task[]
    if (view === 'my-tasks') {
      base = currentUserId ? tasks.filter(t => t.assignedUserId === currentUserId) : []
    } else {
      switch (selection.kind) {
        case 'all': base = tasks; break
        case 'unassigned': base = tasks.filter(t => !t.featureId); break
        case 'epic': {
          const featureIds = new Set(
            epics.find(e => e.id === selection.epicId)?.features.map(f => f.id) ?? []
          )
          base = tasks.filter(t => t.featureId && featureIds.has(t.featureId)); break
        }
        case 'feature': base = tasks.filter(t => t.featureId === selection.featureId); break
        default: base = tasks
      }
    }
    return base
  }, [tasks, epics, selection, view, currentUserId])

  const byStatus = (s: Status) => visibleTasks.filter(t => t.status === s)

  // Derive columns dynamically: all statuses present in the data, ordered by
  // STATUS_ORDER, with any unknowns appended alphabetically at the end.
  const columns = useMemo(() => {
    const present = new Set(visibleTasks.map(t => t.status))
    // Always show core workflow columns even when empty
    STATUS_ORDER.slice(0, 4).forEach(s => present.add(s))
    const ordered = STATUS_ORDER.filter(s => present.has(s))
    const extras = [...present].filter(s => !STATUS_ORDER.includes(s)).sort()
    return [...ordered, ...extras]
  }, [visibleTasks])

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

    // Prepend parent context as background framing so Claude understands lineage without
    // treating the parent plan as the thing to produce — the specific item stays the ask.
    if (target.type === 'feature' && target.parentContext) {
      const { epicTitle, epicDescription, epicPlan } = target.parentContext
      let parentSection = `## Context\n\nThis feature belongs to the epic **"${epicTitle}"**.`
      if (epicDescription) parentSection += `\n\n*Epic description:* ${epicDescription}`
      if (epicPlan) parentSection += `\n\n*Epic plan (for reference — do not re-plan this):*\n${epicPlan}`
      parentSection += `\n\n---\n\n`
      initialContext = parentSection + initialContext
    } else if (target.type === 'task' && target.parentContext) {
      const { featureTitle, featureDescription, featurePlan, epicTitle } = target.parentContext
      let parentSection = `## Context\n\nThis task belongs to the feature **"${featureTitle}"**`
      if (epicTitle) parentSection += ` (part of epic **"${epicTitle}"**)`
      parentSection += `.`
      if (featureDescription) parentSection += `\n\n*Feature description:* ${featureDescription}`
      if (featurePlan) parentSection += `\n\n*Feature plan (for reference — do not re-plan this):*\n${featurePlan}`
      parentSection += `\n\n---\n\n`
      initialContext = parentSection + initialContext
    }

    // Use the unified ChatRoom model for planning conversations
    const r = await fetch('/api/chatrooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:        `${prefix}${target.title}`,
        type:        'planning',
        // Structural links for epic/feature-type planning
        epicId:      target.type === 'epic'     ? target.id : undefined,
        featureId:   target.type === 'feature'  ? target.id : undefined,
        // planTarget stored for caller routing / display
        planTarget:  { type: target.type, id: target.id },
      }),
    })
    const room = await r.json()
    router.push(`/messages?r=${room.id}`)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">

      {/* Top: Tasks / Bugs / My Tasks tab bar */}
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
        <button
          onClick={() => setView('my-tasks')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
            view === 'my-tasks'
              ? 'bg-bg-raised border border-b-0 border-border-subtle text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          <User size={11} />
          My Tasks
          {currentUserId && tasks.filter(t => t.assignedUserId === currentUserId && t.status !== 'done' && t.status !== 'failed').length > 0 && (
            <span className="px-1 py-0.5 text-[9px] rounded bg-accent/20 text-accent">
              {tasks.filter(t => t.assignedUserId === currentUserId && t.status !== 'done' && t.status !== 'failed').length}
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

      {/* Tasks / My Tasks view — same Kanban layout, My Tasks filters to current user */}
      {(view === 'tasks' || view === 'my-tasks') && <div className="flex-1 flex overflow-hidden">

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
              {view === 'my-tasks' && `My Tasks (${visibleTasks.length})`}
              {view === 'tasks' && selection.kind === 'all'        && `All Tasks (${tasks.length})`}
              {view === 'tasks' && selection.kind === 'unassigned' && `Unassigned Tasks (${visibleTasks.length})`}
              {view === 'tasks' && selection.kind === 'epic'       && `${epics.find(e => e.id === selection.epicId)?.title ?? 'Epic'} (${visibleTasks.length})`}
              {view === 'tasks' && selection.kind === 'feature'    && (() => {
                const epic = epics.find(e => e.id === (selection as { epicId: string }).epicId)
                const feat = epic?.features.find(f => f.id === (selection as { featureId: string }).featureId)
                return `${feat?.title ?? 'Feature'} (${visibleTasks.length})`
              })()}
            </h1>
            {/* Show epic/feature detail button — tasks view only */}
            {view === 'tasks' && selection.kind === 'epic' && (
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
            {view === 'tasks' && selection.kind === 'feature' && (
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
          {view === 'tasks' && (
            <button
              onClick={() => setTaskModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent/80 transition-colors"
            >
              <Plus size={14} /> New Task
            </button>
          )}
        </div>

        {/* Board */}
        <KanbanBoard
          columnWidth="w-60"
          columnBg="bg-bg-card"
          columns={columns.map(col => {
            const cfg = STATUS_CONFIG[col] ?? { label: col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), border: 'border-t-border-visible' }
            return {
              key: col,
              label: cfg.label,
              topBorderClass: cfg.border,
              items: byStatus(col),
              emptyText: 'No tasks',
              renderItem: (task: Task) => {
                const p = priorityConfig[task.priority] ?? priorityConfig.medium
                const isSelected = panel?.kind === 'task' && panel.task.id === task.id
                return (
                  <div
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
              },
            }
          })}
        />
      </div>


      </div>}
      {/* end tasks view */}

      {/* ── Task detail panel — rendered outside view blocks so it works from My Tasks too ── */}
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
                onPlanWithClaude={(modelId) => planWithClaude({ type: 'feature', id: panel.feature.id, title: panel.feature.title, description: panel.feature.description, parentContext: { epicTitle: panel.epic.title, epicDescription: panel.epic.description, epicPlan: panel.epic.plan } }, modelId)}
                onGenerateTasks={async () => {
                  const r = await fetch(`/api/features/${panel.feature.id}/generate-tasks`, { method: 'POST' })
                  if (!r.ok) {
                    const body = await r.json().catch(() => ({}))
                    throw new Error(body.error ?? `HTTP ${r.status}`)
                  }
                  const { tasks: newTasks } = await r.json()
                  setTasks(prev => [...newTasks, ...prev])
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
                  <button onClick={() => { setTaskTab('chat'); loadChat(panel.task.id) }}
                    className={`px-3 py-2 text-[11px] font-medium border-b-2 transition-colors ${taskTab === 'chat' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-secondary'}`}>
                    Chat
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
                      {activeAgents.map(a => <option key={a.id} value={a.id}>{a.name}{a.role ? ` (${a.role})` : ''}</option>)}
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
                      {columns.map(col => {
                        const cfg = STATUS_CONFIG[col] ?? { label: col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), border: 'border-t-border-visible' }
                        return (
                        <button key={col} onClick={() => updateTask(panel.task.id, { status: col })}
                          className={`px-2 py-1.5 rounded text-[10px] font-medium transition-colors ${
                            panel.task.status === col ? 'bg-accent text-white' : 'bg-bg-raised text-text-muted hover:text-text-primary hover:bg-bg-card border border-border-subtle'
                          }`}>
                          {cfg.label}
                        </button>
                        )
                      })}
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

                  {taskTab === 'chat' && (
                    <TaskChat rooms={taskChatRooms} loading={chatLoading} activeRoom={activeChatRoom}
                      onRoomChange={setActiveChatRoom} onSend={sendChatMessage} sending={chatSending}
                      inputRef={chatInputRef} onInput={setChatInput} input={chatInput}
                      onOpenChat={roomId => router.push(`/messages?r=${roomId}`)} />
                  )}
                </div>
                {taskTab === 'details' && (
                <div className="p-3 border-t border-border-subtle space-y-2">
                  <PlanWithAIButton onSelect={modelId => {
                    const parentFeature = panel.task.featureId ? epics.flatMap(e => e.features).find(f => f.id === panel.task.featureId) : undefined
                    const parentEpic = parentFeature ? epics.find(e => e.id === parentFeature.epicId) : undefined
                    planWithClaude({
                      type: 'task',
                      id: panel.task.id,
                      title: panel.task.title,
                      description: panel.task.description,
                      parentContext: parentFeature ? {
                        featureTitle: parentFeature.title,
                        featureDescription: parentFeature.description,
                        featurePlan: parentFeature.plan,
                        epicTitle: parentEpic?.title ?? '',
                        epicDescription: parentEpic?.description ?? null,
                        epicPlan: parentEpic?.plan ?? null,
                      } : undefined,
                    }, modelId)
                  }} />
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

      {/* Create Task */}
      {taskModal && (
        <CreateEntityModal
          title="New Task"
          subtitle={activeFeatureId ? `Adding to: ${epics.flatMap(e => e.features).find(f => f.id === activeFeatureId)?.title}` : undefined}
          onClose={() => setTaskModal(false)}
          onSubmit={createTask}
          submitLabel="Create Task"
          submitting={saving}
          submitDisabled={!taskForm.title.trim()}
        >
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
        </CreateEntityModal>
      )}

      {/* Create Epic */}
      {epicModal && (
        <CreateEntityModal
          title="New Epic"
          onClose={() => setEpicModal(false)}
          onSubmit={createEpic}
          submitLabel="Create Epic"
          submitting={saving}
          submitDisabled={!epicForm.title.trim()}
        >
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
        </CreateEntityModal>
      )}

      {/* Create Feature */}
      {featureModal && (
        <CreateEntityModal
          title="New Feature"
          subtitle={`Under: ${featureModal.epicTitle}`}
          onClose={() => setFeatureModal(null)}
          onSubmit={createFeature}
          submitLabel="Create Feature"
          submitting={saving}
          submitDisabled={!featureForm.title.trim()}
        >
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
        </CreateEntityModal>
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

// ── TaskChat ───────────────────────────────────────────────────────────────────

const SENDER_BG: Record<string, string> = {
  agent: 'bg-accent/15 text-accent border-accent/20',
  user: 'bg-bg-raised text-text-secondary border-border-subtle',
  system: 'bg-bg-raised text-text-muted border-border-subtle italic',
}

function TaskChat({
  rooms, loading, activeRoom, onRoomChange, onSend, sending, inputRef, onInput, input, onOpenChat
}: {
  rooms: Array<{id:string;name:string;type:string;messages:Array<{id:string;senderType:string;content:string;sender:{type:string;id:string|null;name:string};createdAt:string}>}>
  loading: boolean
  activeRoom: string | null
  onRoomChange: (id: string) => void
  onSend: () => void
  sending: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  onInput: (v: string) => void
  input: string
  onOpenChat?: (roomId: string) => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [rooms, activeRoom])

  if (loading) return (
    <div className="flex items-center justify-center py-12 text-text-muted text-xs">Loading chat…</div>
  )

  const allRooms = rooms.length > 0 ? rooms : [{
    id: '', name: 'Task Chat', type: 'task', messages: [] as Array<{id:string;senderType:string;content:string;sender:{type:string;id:string|null;name:string};createdAt:string}>,
  }]

  const currentRoom = activeRoom
    ? allRooms.find(r => r.id === activeRoom)
    : allRooms[0]

  if (!currentRoom) return null

  const messages = currentRoom.messages.length > 0 ? currentRoom.messages : []

  const roomIdForLink = activeRoom ?? (rooms[0]?.id ?? null)

  return (
    <div className="flex flex-col h-full">
      {/* Room selector + open in chat button */}
      <div className="flex items-center gap-1.5 mb-3">
        {rooms.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1 flex-1">
            {rooms.map(room => (
              <button
                key={room.id}
                onClick={() => onRoomChange(room.id)}
                className={`flex-shrink-0 px-2.5 py-1 rounded text-[10px] border transition-colors ${
                  activeRoom === room.id
                    ? 'bg-accent/15 border-accent/40 text-accent'
                    : 'bg-bg-raised border-border-subtle text-text-muted hover:text-text-secondary'
                }`}
              >
                {room.name}
              </button>
            ))}
          </div>
        )}
        {roomIdForLink && onOpenChat && (
          <button
            onClick={() => onOpenChat(roomIdForLink)}
            className="flex-shrink-0 ml-auto flex items-center gap-1 px-2.5 py-1 rounded text-[10px] border border-border-subtle bg-bg-raised text-text-muted hover:text-text-secondary hover:border-accent/40 transition-colors"
            title="Open full feature chat room"
          >
            <MessageSquare size={10} />
            Open in Chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {!messages.length ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-text-muted">
            <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-3">
              <MessageSquare size={22} className="text-accent" />
            </div>
            <p className="text-xs">No messages yet</p>
            <p className="text-[10px] mt-1 opacity-60">Bot conversations for this task appear here.</p>
          </div>
        ) : (
          messages.map(msg => {
            const isAgent = msg.senderType === 'agent'
            const isSystem = msg.senderType === 'system'
            return (
              <div key={msg.id} className={`rounded-lg border px-3 py-2 text-xs ${SENDER_BG[msg.senderType] ?? SENDER_BG.system}`}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[9px] font-semibold text-text-secondary">
                    {isAgent ? msg.sender.name : msg.sender.name || 'system'}
                  </span>
                  <span className="text-[8px] text-text-muted flex-shrink-0">
                    {new Date(msg.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap break-words leading-relaxed font-mono text-[11px]">{msg.content}</pre>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border-subtle p-2.5 flex gap-2 flex-shrink-0 mt-2">
        <input
          ref={inputRef as any}
          value={input}
          onChange={e => onInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }}}
          placeholder="Send a message…"
          disabled={sending}
          className="flex-1 px-3 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
        />
        <button
          onClick={onSend}
          disabled={!input.trim() || sending}
          className="p-1.5 rounded-lg bg-accent text-white hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  )
}
