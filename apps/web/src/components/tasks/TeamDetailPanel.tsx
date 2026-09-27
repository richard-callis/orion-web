'use client'
import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { X, Plus, Bot, User, Cpu, Rocket, Archive } from 'lucide-react'
import type { Agent } from '@/types/tasks'
import { NovaBrowser, Toast, type NovaImportResult, type ToastState } from '@/components/nova/NovaBrowser'
import { useToast } from '@/components/ui/Toast'
import { Dialog } from '@/components/ui/Dialog'
import { IconButton } from '@/components/ui/Button'
import { apiFetch, errorMessage } from '@/lib/api'
import { CreateAgentDialog, EditAgentDialog, PlanAgentDialog, type AgentDraft } from './team/AgentDialogs'
import {
  agentColor, agentInitials, agentLlm, createBody, editPatch, isArchived, modelDisplayLabel,
  type AgentForm, type ModelOption,
} from './team/agent-form'

export { agentInitials }

const TYPE_ICONS: Record<string, React.ReactNode> = {
  claude: <Cpu size={10} />,
  human:  <User size={10} />,
  ollama: <Bot size={10} className="text-orange-400" />,
  custom: <Bot size={10} />,
}

const FALLBACK_PLAN_PROMPT =
  "I want to create a new agent for my homelab team. Help me define what this agent should do. Ask me what kind of agent I need, its responsibilities, and if it's an AI agent, help me write a good system prompt for it."

const NO_MODELS: ModelOption[] = []

export function TeamDetailPanel({ initialAgents = [], onClose }: { initialAgents?: Agent[]; onClose?: () => void }) {
  const toast = useToast()
  const router = useRouter()

  // Agent list: server-rendered on first paint, then kept fresh by SWR.
  const { data: agents = initialAgents, mutate: mutateAgents } = useSWR<Agent[]>('/api/agents', { fallbackData: initialAgents })
  const { data: models = NO_MODELS } = useSWR<ModelOption[]>('/api/models', { revalidateOnFocus: false })

  const [showArchived, setShowArchived] = useState(false)
  const [createOpen, setCreateOpen]     = useState(false)
  const [editing, setEditing]           = useState<Agent | null>(null)
  const [saving, setSaving]             = useState(false)
  const [showNovaBrowser, setShowNovaBrowser] = useState(false)
  const [importToast, setImportToast]   = useState<ToastState | null>(null)
  const [planning, setPlanning]         = useState<{ conversationId: string; prompt: string } | null>(null)
  const [draftCreating, setDraftCreating] = useState(false)

  const displayAgents = agents.filter(a => showArchived ? isArchived(a) : !isArchived(a))

  const addAgent = (agent: Agent) => { void mutateAgents(prev => [...(prev ?? []), agent], { revalidate: false }) }

  // ── Create / edit / delete ──────────────────────────────────────────────────

  const create = async (form: AgentForm) => {
    setSaving(true)
    try {
      addAgent(await apiFetch<Agent>('/api/agents', { method: 'POST', body: createBody(form) }))
      setCreateOpen(false)
    } catch (err) {
      toast.error(`Failed to create agent: ${errorMessage(err, 'Unknown error')}`)
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = async (form: AgentForm) => {
    if (!editing) return
    const id = editing.id
    const patch = editPatch(form)
    setSaving(true)
    // Optimistic; roll back if the server rejects it.
    await mutateAgents(
      async prev => {
        await apiFetch(`/api/agents/${id}`, { method: 'PUT', body: patch as Record<string, unknown> })
        return (prev ?? []).map(a => a.id === id ? { ...a, ...patch } : a)
      },
      {
        optimisticData: prev => (prev ?? []).map(a => a.id === id ? { ...a, ...patch } : a),
        rollbackOnError: true,
        revalidate: false,
      },
    ).catch(err => toast.error(`Failed to save agent: ${errorMessage(err)}`))
    setSaving(false)
    setEditing(null)
  }

  const remove = async () => {
    if (!editing) return
    const id = editing.id
    setEditing(null)
    await mutateAgents(
      async prev => {
        await apiFetch(`/api/agents/${id}`, { method: 'DELETE' })
        return (prev ?? []).filter(a => a.id !== id)
      },
      { optimisticData: prev => (prev ?? []).filter(a => a.id !== id), rollbackOnError: true, revalidate: false },
    ).catch(err => toast.error(`Failed to delete agent: ${errorMessage(err)}`))
  }

  // ── Navigation to chat rooms ────────────────────────────────────────────────

  const openRoom = async (what: string, request: () => Promise<{ roomId?: string; id?: string }>) => {
    try {
      const res = await request()
      router.push(`/messages?r=${res.roomId ?? res.id}`)
    } catch (err) {
      toast.error(`Failed to open ${what}: ${errorMessage(err)}`)
    }
  }

  const chatWithAgent = (agent: Agent) =>
    openRoom('chat', () => apiFetch(`/api/agents/${agent.id}/chat`, { method: 'POST', body: {} }))

  const planAgentRoom = (agent: Agent) =>
    openRoom('planning room', () => apiFetch('/api/chatrooms', {
      method: 'POST', body: { name: `Agent: ${agent.name}`, type: 'planning', agentId: agent.id },
    }))

  // ── Plan a new agent with AI ────────────────────────────────────────────────

  const startPlanning = async () => {
    setCreateOpen(false)
    try {
      const prompt = await apiFetch<{ content: string }>('/api/admin/prompts/context.agent-create')
        .then(r => r.content)
        .catch(() => FALLBACK_PLAN_PROMPT)
      // A real conversation in agent-draft mode (the same mode /chat uses).
      const convo = await apiFetch<{ id: string }>('/api/chat/conversations', {
        method: 'POST', body: { title: 'Plan: New Agent', agentDraft: true },
      })
      setPlanning({ conversationId: convo.id, prompt })
    } catch (err) {
      toast.error(`Failed to start planning: ${errorMessage(err)}`)
    }
  }

  const createFromDraft = async (draft: AgentDraft, systemPrompt: string | undefined) => {
    if (!draft.name.trim()) return
    setDraftCreating(true)
    try {
      addAgent(await apiFetch<Agent>('/api/agents', {
        method: 'POST',
        body: {
          name: draft.name,
          type: draft.type === 'custom' ? 'claude' : draft.type,
          role: draft.role || null,
          metadata: systemPrompt ? { systemPrompt } : undefined,
        },
      }))
      setPlanning(null)
    } catch (err) {
      toast.error(`Failed to create agent: ${errorMessage(err, 'Unknown error')}`)
    } finally {
      setDraftCreating(false)
    }
  }

  // ── Nebula import ───────────────────────────────────────────────────────────

  const handleNovaImport = (result: NovaImportResult) => {
    setShowNovaBrowser(false)
    // Own the success toast here — NovaBrowser (and any toast it rendered)
    // unmounts as soon as the panel closes above, so it can't display this.
    setImportToast({ message: result.message, type: 'success', prUrl: result.prUrl })
    void mutateAgents()
  }

  const dismissImportToast = useCallback(() => setImportToast(null), [])

  return (
    <>
      {importToast && (
        <Toast message={importToast.message} type={importToast.type} prUrl={importToast.prUrl} onDismiss={dismissImportToast} />
      )}
      <aside className="h-44 shrink-0 md:flex-none md:h-full md:w-80 flex flex-col border-r border-b md:border-b-0 border-border-subtle bg-bg-sidebar overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
          <span className="text-xs font-semibold text-text-secondary">
            {showArchived ? 'Archived' : 'Active'} ({displayAgents.length})
          </span>
          <div className="flex items-center gap-1">
            <IconButton
              label={showArchived ? 'Show active agents' : 'Show archived agents'}
              aria-pressed={showArchived}
              onClick={() => setShowArchived(v => !v)}
              className={showArchived ? 'text-accent' : ''}
            >
              <Archive size={13} />
            </IconButton>
            {onClose && <IconButton label="Close" onClick={onClose}><X size={14} /></IconButton>}
          </div>
        </div>

        <ul className="flex-1 overflow-y-auto p-3 space-y-2">
          {displayAgents.map((agent, i) => (
            <li key={agent.id}>
              <button
                onClick={() => setEditing(agent)}
                className="w-full text-left rounded-lg border border-border-subtle bg-bg-raised p-3 hover:border-accent/40 hover:bg-bg-card transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <div className={`w-7 h-7 rounded-full ${agentColor(i)} flex items-center justify-center shrink-0`} aria-hidden>
                    <span className="text-[10px] font-bold text-white">{agentInitials(agent.name)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-text-primary truncate">{agent.name}</span>
                      <span className="text-text-muted shrink-0" aria-label={agent.type}>{TYPE_ICONS[agent.type] ?? TYPE_ICONS.custom}</span>
                    </div>
                    {agent.role && <span className="text-[10px] text-accent">{agent.role}</span>}
                  </div>
                </div>
                {agent.description && (
                  <p className="text-[10px] text-text-muted mt-1.5 leading-relaxed line-clamp-2 ml-9">{agent.description}</p>
                )}
                {agent.type !== 'human' && (
                  <p className="text-[10px] text-accent/60 mt-1 ml-9 italic line-clamp-1">
                    {modelDisplayLabel(agentLlm(agent), models)}
                  </p>
                )}
              </button>
            </li>
          ))}

          {displayAgents.length === 0 && (
            <li className="text-[10px] text-text-muted text-center py-6">
              {showArchived ? 'No archived agents' : 'No active agents — add your first team member'}
            </li>
          )}
        </ul>

        <div className="flex border-t border-border-subtle">
          <button onClick={() => setCreateOpen(true)}
            className="flex-1 flex items-center gap-2 px-4 py-2.5 text-xs text-text-muted hover:text-accent hover:bg-bg-raised transition-colors">
            <Plus size={13} /> Add Agent
          </button>
          <button onClick={() => setShowNovaBrowser(true)}
            className="flex items-center gap-2 px-4 py-2.5 text-xs text-text-muted hover:text-accent hover:bg-bg-raised transition-colors border-l border-border-subtle"
            title="Browse Nebula service catalog to import agents">
            <Rocket size={13} /> Nebula
          </button>
        </div>
      </aside>

      {createOpen && (
        <CreateAgentDialog
          models={models}
          saving={saving}
          onClose={() => setCreateOpen(false)}
          onCreate={form => void create(form)}
          onPlanWithAI={() => void startPlanning()}
        />
      )}

      {planning && (
        <PlanAgentDialog
          conversationId={planning.conversationId}
          initialPrompt={planning.prompt}
          creating={draftCreating}
          onClose={() => setPlanning(null)}
          onCreate={(draft, systemPrompt) => void createFromDraft(draft, systemPrompt)}
        />
      )}

      {editing && (
        <EditAgentDialog
          key={editing.id}
          agent={editing}
          colorIndex={agents.findIndex(a => a.id === editing.id)}
          models={models}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={form => void saveEdit(form)}
          onDelete={() => void remove()}
          onChat={() => void chatWithAgent(editing)}
          onPlan={() => void planAgentRoom(editing)}
        />
      )}

      {/* Nebula browser panel — slides in from the right */}
      {showNovaBrowser && createPortal(
        <Dialog
          onClose={() => setShowNovaBrowser(false)}
          label="Nebula catalog"
          className="w-80 h-full bg-bg-sidebar border-l border-border-subtle shadow-xl overflow-hidden flex flex-col"
          overlayClassName="items-stretch justify-end p-0 bg-transparent backdrop-blur-none"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
            <span className="text-xs font-semibold text-text-primary">Nebula Catalog</span>
            <IconButton label="Close Nebula catalog" onClick={() => setShowNovaBrowser(false)} className="p-0"><X size={14} /></IconButton>
          </div>
          <NovaBrowser onImport={handleNovaImport} />
        </Dialog>,
        document.body
      )}
    </>
  )
}
