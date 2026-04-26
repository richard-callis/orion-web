'use client'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { X, Plus, Trash2, Bot, User, Cpu, MessageSquarePlus, MessageSquare, Rocket, Loader2, Check, Send, Square } from 'lucide-react'
import type { Agent } from '@/types/tasks'
import { NovaBrowser } from '@/components/nova/NovaBrowser'

const ROLE_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-emerald-500', 'bg-orange-500',
  'bg-pink-500', 'bg-cyan-500', 'bg-yellow-500', 'bg-red-500',
]

const TYPE_ICONS: Record<string, React.ReactNode> = {
  claude: <Cpu size={10} />,
  human:  <User size={10} />,
  ollama: <Bot size={10} className="text-orange-400" />,
  custom: <Bot size={10} />,
}

function agentColor(index: number) { return ROLE_COLORS[index % ROLE_COLORS.length] }

export function agentInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

interface AgentForm {
  name: string
  modelId: string   // 'human' | 'claude:claude-sonnet-4-6' | 'gemini:*' | 'ext:<cuid>'
  role: string
  description: string
  systemPrompt: string
  persistent: boolean    // always-on watcher agent
  watchPrompt: string    // what to check/do on each watch cycle
  watchIntervalMin: number // how often to run (minutes)
  tools: boolean         // enable ORION tool calling (create tasks, agents, etc.)
}

const DEFAULT_MODEL = 'claude:claude-sonnet-4-6'
const emptyForm: AgentForm = { name: '', modelId: DEFAULT_MODEL, role: '', description: '', systemPrompt: '', persistent: false, watchPrompt: '', watchIntervalMin: 60, tools: false }

function modelIdToType(modelId: string): string {
  if (modelId === 'human')             return 'human'
  if (modelId.startsWith('claude:'))   return 'claude'
  if (modelId.startsWith('gemini:'))   return 'custom'
  if (modelId.startsWith('ollama:') || modelId.startsWith('ext:')) return 'ollama'
  return 'custom'
}

function modelDisplayLabel(llm: string | undefined, models: Array<{id: string; name: string}>): string {
  if (!llm) return 'AI agent'
  const found = models.find(m => m.id === llm)
  if (found) return found.name
  if (llm.startsWith('claude:')) return `Claude · ${llm.slice('claude:'.length).replace('claude-', '').replace(/-\d{8}/, '')}`
  if (llm.startsWith('ollama:')) return `Ollama · ${llm.slice('ollama:'.length)}`
  if (llm.startsWith('gemini:')) return `Gemini · ${llm.slice('gemini:'.length)}`
  return llm
}

interface Props {
  initialAgents?: Agent[]
  agents?: Agent[]
  onCreate?: (agent: Agent) => void
  onUpdate?: (id: string, patch: Partial<Agent>) => void
  onDelete?: (id: string) => void
  onClose?: () => void
}

export function TeamDetailPanel({ initialAgents, agents: agentsProp, onCreate, onUpdate, onDelete, onClose }: Props) {
  const [localAgents, setLocalAgents] = useState<Agent[]>(initialAgents ?? [])
  const agents = agentsProp ?? localAgents

  const [createModal, setCreateModal]   = useState(false)
  const [form, setForm]                 = useState<AgentForm>(emptyForm)
  const [modalAgent, setModalAgent]     = useState<Agent | null>(null)
  const [editForm, setEditForm]         = useState<AgentForm>(emptyForm)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showNovaBrowser, setShowNovaBrowser] = useState(false)
  const [saving, setSaving]             = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<{id: string; name: string; provider: string; builtIn: boolean}>>([])

  // Planning mode state
  const [planningMode, setPlanningMode] = useState(false)
  const [planningConvId, setPlanningConvId] = useState('')
  const [planningMessages, setPlanningMessages] = useState<Array<{role: string; content: string; toolCalls?: Array<{tool: string; input: string; output?: string}>; streaming?: boolean}>>([])
  const [planningStreaming, setPlanningStreaming] = useState(false)
  const [planningInput, setPlanningInput] = useState('')
  const [draftForm, setDraftForm] = useState({ name: '', role: '', type: 'claude' })
  const [draftCreating, setDraftCreating] = useState(false)
  const initialContextRef = useRef<string | null>(null)
  const planningAbortRef = useRef<AbortController | null>(null)
  const planningBottomRef = useRef<HTMLDivElement>(null)
  const planningInputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  useEffect(() => { fetch('/api/models').then(r => r.json()).then(setAvailableModels).catch(() => {}) }, [])

  const openModal = (agent: Agent) => {
    const meta = agent.metadata as Record<string, unknown> | null
    const contextConfig = meta?.contextConfig as Record<string, string | boolean | number> | undefined
    const llm = (contextConfig?.llm as string | undefined) ?? (agent.type !== 'human' ? DEFAULT_MODEL : 'human')
    setEditForm({
      name:             agent.name,
      modelId:          llm,
      role:             agent.role ?? '',
      description:      agent.description ?? '',
      systemPrompt:     (meta?.systemPrompt as string) ?? '',
      persistent:       (contextConfig?.persistent as boolean) ?? false,
      watchPrompt:      (contextConfig?.watchPrompt as string) ?? '',
      watchIntervalMin: (contextConfig?.watchIntervalMin as number) ?? 60,
      tools:            (contextConfig?.tools as boolean) ?? false,
    })
    setConfirmDelete(false)
    setModalAgent(agent)
  }

  const closeModal = () => { setModalAgent(null); setConfirmDelete(false) }

  const chatWithAgent = async () => {
    if (!modalAgent) return
    const r = await fetch('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Chat: ${modalAgent.name}`, agentChat: { id: modalAgent.id, name: modalAgent.name } }),
    })
    const convo = await r.json()
    router.push(`/chat?conversation=${convo.id}`)
  }

  const planWithClaude = async () => {
    if (!modalAgent) return
    const r = await fetch('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Agent: ${modalAgent.name}`, agentTarget: { id: modalAgent.id, name: modalAgent.name } }),
    })
    const convo = await r.json()
    router.push(`/chat?conversation=${convo.id}`)
  }

   const startPlanning = async () => {
    setPlanningMode(true)
    setPlanningMessages([])
    setDraftForm({ name: '', role: '', type: 'claude' })
    setPlanningInput('')
    try {
      const tmplRes = await fetch('/api/admin/prompts/context.agent-create')
     const ctx = tmplRes.ok
        ? ((await tmplRes.json() as { content: string }).content)
        : "I want to create a new agent for my homelab team. Help me define what this agent should do. Ask me what kind of agent I need, its responsibilities, and if it's an AI agent, help me write a good system prompt for it."
      initialContextRef.current = ctx
      const r = await fetch('/api/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `Plan: ${form.name || 'New Agent'}`, agentDraft: true, initialContext: ctx }),
      })
      const convo = await r.json()
      setPlanningConvId(convo.id)
      // Auto-send the initial context so Claude gets its planning instructions
      sendToPlanning(ctx)
    } catch (err) {
      console.error('Failed to start planning:', err)
      setPlanningMode(false)
    }
  }

  const sendToPlanning = async (promptOverride?: string) => {
    const prompt = (promptOverride ?? planningInput).trim()
    if (!prompt || planningStreaming || !planningConvId) return
    setPlanningInput('')
    setPlanningStreaming(true)

    const abort = new AbortController()
    planningAbortRef.current = abort

    const userMsg = { role: 'user' as const, content: prompt, toolCalls: [] as Array<{tool: string; input: string; output?: string}> }
    const assistantMsg = { role: 'assistant' as const, content: '', toolCalls: [], streaming: true }
    setPlanningMessages(prev => [...prev, userMsg, assistantMsg])

    try {
      const resp = await fetch(`/api/chat/conversations/${planningConvId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: abort.signal,
      })
      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() ?? ''
        for (const block of lines) {
          const eventLine = block.split('\n').find(l => l.startsWith('event:'))
          const dataLine  = block.split('\n').find(l => l.startsWith('data:'))
          if (!eventLine || !dataLine) continue
          const event = eventLine.replace('event: ', '').trim()
          const data = JSON.parse(dataLine.replace('data: ', ''))
          setPlanningMessages(prev => {
            const msgs = [...prev]
            const last = msgs[msgs.length - 1]
            if (!last || last.role !== 'assistant') return prev
            if (event === 'text' && data.content) last.content += data.content
            else if (event === 'tool_call') last.toolCalls = [...(last.toolCalls ?? []), { tool: data.tool!, input: data.input! }]
            else if (event === 'tool_result') { const tc = last.toolCalls?.[last.toolCalls.length - 1]; if (tc) tc.output = data.output }
            else if (event === 'done' || event === 'error') {
              last.streaming = false
              if (event === 'error') last.content += `\n\n⚠ ${data.error ?? 'Error'}`
            }
            return msgs
          })
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setPlanningMessages(prev => {
          const msgs = [...prev]
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant') { last.streaming = false; last.content += `\n\n⚠ Error: ${err}` }
          return msgs
        })
      }
    } finally {
      planningAbortRef.current = null
      setPlanningStreaming(false)
      setPlanningMessages(prev => {
        const msgs = [...prev]
        const last = msgs[msgs.length - 1]
        if (last?.role === 'assistant') last.streaming = false
        return msgs
      })
    }
  }

  const createFromDraft = async () => {
    if (!draftForm.name.trim()) return
    setDraftCreating(true)
    try {
      const lastAssistant = [...planningMessages].reverse().find(m => m.role === 'assistant')
      const agentRes = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draftForm.name,
          type: (draftForm.type === 'custom' ? 'claude' : draftForm.type),
          role: draftForm.role || null,
          metadata: lastAssistant?.content?.trim() ? { systemPrompt: lastAssistant.content.trim() } : undefined,
        }),
      })
      if (!agentRes.ok) { const err = await agentRes.json().catch(() => ({})); throw new Error(err.error ?? 'Failed to create agent') }
      const agent = await agentRes.json()
      if (onCreate) onCreate(agent)
      else setLocalAgents(prev => [...prev, agent])
      setPlanningMode(false)
      setPlanningConvId('')
      setPlanningMessages([])
      setDraftForm({ name: '', role: '', type: 'claude' })
    } catch (err) {
      console.error('Failed to create agent:', err)
      alert(`Failed to create agent: ${err instanceof Error ? err.message : 'Unknown error'}`)
      setDraftCreating(false)
    }
  }

  const handleNovaImport = (novaName: string) => {
    setShowNovaBrowser(false)
    // Refresh the agents list after import
    fetch('/api/agents').then(r => r.json()).then(setLocalAgents).catch(() => {})
  }

  const openCreate = () => { setForm(emptyForm); setCreateModal(true) }
  const closeCreate = () => { setCreateModal(false); setForm(emptyForm) }

  const create = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const isHuman = form.modelId === 'human'
      const r = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          type: modelIdToType(form.modelId),
          role: form.role || null,
          description: form.description || null,
          metadata: !isHuman ? {
            systemPrompt: form.systemPrompt || undefined,
            contextConfig: {
              llm: form.modelId,
              ...(form.tools && { tools: true }),
            },
          } : undefined,
        }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error(err.error ?? 'Failed to create agent')
      }
      const agent: Agent = await r.json()
      if (onCreate) onCreate(agent)
      else setLocalAgents(prev => [...prev, agent])
      setCreateModal(false)
      setForm(emptyForm)
    } catch (err) {
      console.error('Failed to create agent:', err)
      alert(`Failed to create agent: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = async () => {
    if (!modalAgent) return
    setSaving(true)
    const isHuman = editForm.modelId === 'human'
    const patch: Partial<Agent> = {
      name: editForm.name,
      type: modelIdToType(editForm.modelId),
      role: editForm.role || null,
      description: editForm.description || null,
      metadata: !isHuman ? {
        systemPrompt: editForm.systemPrompt || undefined,
        contextConfig: {
          llm: editForm.modelId,
          ...(editForm.persistent && {
            persistent: true,
            watchPrompt: editForm.watchPrompt,
            watchIntervalMin: editForm.watchIntervalMin,
          }),
          ...(editForm.tools && { tools: true }),
        },
      } : null,
    }
    if (onUpdate) onUpdate(modalAgent.id, patch)
    else {
      setLocalAgents(prev => prev.map(a => a.id === modalAgent.id ? { ...a, ...patch } : a))
      await fetch(`/api/agents/${modalAgent.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      }).catch(() => {})
    }
    setSaving(false)
    closeModal()
  }

  const handleDelete = () => {
    if (!modalAgent) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    if (onDelete) onDelete(modalAgent.id)
    else {
      setLocalAgents(prev => prev.filter(a => a.id !== modalAgent.id))
      fetch(`/api/agents/${modalAgent.id}`, { method: 'DELETE' }).catch(() => {})
    }
    closeModal()
  }

  const inputCls = 'w-full px-2.5 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent'
  const modalInputCls = 'w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent'

  return (
    <>
      <aside className="h-44 flex-shrink-0 md:flex-none md:h-full md:w-80 flex flex-col border-r border-b md:border-b-0 border-border-subtle bg-bg-sidebar overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <span className="text-xs font-semibold text-text-secondary">Team ({agents.length})</span>
          {onClose && <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={14} /></button>}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {agents.map((agent, i) => (
            <button
              key={agent.id}
              onClick={() => openModal(agent)}
              className="w-full text-left rounded-lg border border-border-subtle bg-bg-raised p-3 hover:border-accent/40 hover:bg-bg-card transition-colors"
            >
              <div className="flex items-center gap-2.5">
                <div className={`w-7 h-7 rounded-full ${agentColor(i)} flex items-center justify-center flex-shrink-0`}>
                  <span className="text-[10px] font-bold text-white">{agentInitials(agent.name)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-text-primary truncate">{agent.name}</span>
                    <span className="text-text-muted flex-shrink-0">{TYPE_ICONS[agent.type] ?? TYPE_ICONS.custom}</span>
                  </div>
                  {agent.role && <span className="text-[10px] text-accent">{agent.role}</span>}
                </div>
              </div>
              {agent.description && (
                <p className="text-[10px] text-text-muted mt-1.5 leading-relaxed line-clamp-2 ml-9">{agent.description}</p>
              )}
              {agent.type !== 'human' && (
                <p className="text-[10px] text-accent/60 mt-1 ml-9 italic line-clamp-1">
                  {modelDisplayLabel(
                    (((agent.metadata as Record<string,unknown>)?.contextConfig) as Record<string,string>|undefined)?.llm,
                    availableModels
                  )}
                </p>
              )}
            </button>
          ))}

          {agents.length === 0 && (
            <p className="text-[10px] text-text-muted text-center py-6">No agents yet — add your first team member</p>
          )}
        </div>

        <div className="flex border-t border-border-subtle">
          <button onClick={openCreate}
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

      {/* Create agent modal */}
      {createModal && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={closeCreate}>
          <div className="w-full max-w-md bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
              <h2 className="text-sm font-semibold text-text-primary">New Agent</h2>
              <button onClick={closeCreate} className="p-1.5 rounded text-text-muted hover:text-text-primary"><X size={14} /></button>
            </div>
            <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
              <div>
                <label className="block text-xs text-text-muted mb-1">Name *</label>
                <input autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && create()}
                  placeholder="e.g. Alpha" className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Role</label>
                <input value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  placeholder="e.g. DevOps Engineer" className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Model</label>
                <select value={form.modelId} onChange={e => setForm(f => ({ ...f, modelId: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent">
                  <option value="human">Human (no AI)</option>
                  {availableModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Description</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  rows={3} placeholder="Responsibilities & expertise..."
                  className="w-full px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary resize-none focus:outline-none focus:border-accent" />
              </div>
              {form.modelId !== 'human' && (
                <>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">System Prompt</label>
                    <textarea value={form.systemPrompt} onChange={e => setForm(f => ({ ...f, systemPrompt: e.target.value }))}
                      rows={4} placeholder="How this agent should behave, its persona, constraints..."
                      className="w-full px-3 py-2 text-sm rounded border border-accent/30 bg-accent/5 text-text-primary resize-none focus:outline-none focus:border-accent" />
                  </div>
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input type="checkbox" checked={form.tools}
                      onChange={e => setForm(f => ({ ...f, tools: e.target.checked }))}
                      className="w-3.5 h-3.5 accent-accent" />
                    <span className="text-xs font-medium text-text-primary">ORION tools</span>
                    <span className="text-[10px] text-text-muted">— can create tasks, agents, and more in chat</span>
                  </label>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
              <button onClick={closeCreate} className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button onClick={() => { setCreateModal(false); startPlanning(); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors">
                <MessageSquarePlus size={11} /> Plan with AI
              </button>
              <button onClick={create} disabled={!form.name.trim() || saving}
                className="px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {saving ? 'Adding…' : 'Add Agent'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Planning mode — inline chat with Claude for agent creation */}
      {planningMode && planningConvId && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setPlanningMode(false)}>
          <div className="w-full max-w-2xl bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-modal-lg" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
              <div className="flex items-center gap-2">
                <Bot size={14} className="text-accent" />
                <span className="text-xs font-semibold text-text-primary">Plan with AI</span>
              </div>
              <button onClick={() => setPlanningMode(false)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={14} /></button>
            </div>
            {/* Agent creation banner — shown after Claude responds */}
            {planningMessages.some(m => m.role === 'assistant') && (
              <>
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-accent/5 flex-shrink-0">
                  <Bot size={13} className="text-accent flex-shrink-0" />
                  <span className="text-xs text-accent flex-1">Agent creation mode — chat with Claude to define your agent</span>
                </div>
                <div className="flex items-center gap-2 px-4 pb-2.5 flex-shrink-0">
                  <input value={draftForm.name} onChange={e => setDraftForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Agent name *"
                    className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent" />
                  <input value={draftForm.role} onChange={e => setDraftForm(f => ({ ...f, role: e.target.value }))}
                    placeholder="Role (e.g. DevOps)"
                    className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent" />
                  <select value={draftForm.type} onChange={e => setDraftForm(f => ({ ...f, type: e.target.value }))}
                    className="px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent">
                    <option value="claude">Claude</option>
                    <option value="human">Human</option>
                    <option value="custom">Custom</option>
                  </select>
                  <button onClick={createFromDraft} disabled={!draftForm.name.trim() || draftCreating}
                    className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-accent/15 text-accent hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap">
                    {draftCreating ? <><Loader2 size={11} className="animate-spin" /> Creating…</> : <><Check size={11} /> Create Agent</>}
                  </button>
                </div>
              </>
            )}
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {!planningMessages.length ? (
                <div className="flex flex-col items-center justify-center h-full text-center text-text-muted">
                  <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-4"><Bot size={22} className="text-accent" /></div>
                  <p className="text-sm">Creating a new agent</p>
                  <p className="text-xs mt-1 opacity-60">Describe what you need — Claude will help define the role, responsibilities, and system prompt.</p>
                </div>
              ) : (
                planningMessages.map((msg, i) => (
                  <div key={i} className={msg.role === 'user' ? 'text-right' : ''}>
                    <div className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap ${
                      msg.role === 'user' ? 'bg-accent/20 text-accent' : 'bg-bg-raised text-text-secondary border border-border-subtle'
                    }`}>
                      {msg.content}
                      {msg.toolCalls?.map((tc, j) => (
                        <div key={j} className="mt-1 text-[10px] text-text-muted">Tool: {tc.tool}</div>
                      ))}
                    </div>
                  </div>
                ))
              )}
              <div ref={planningBottomRef} />
            </div>
            {/* Input */}
            <div className="border-t border-border-subtle p-3 flex-shrink-0">
              <div className="flex gap-2">
                <input ref={planningInputRef} value={planningInput} onChange={e => setPlanningInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendToPlanning() }}}
                  placeholder={planningMessages.length === 0 ? "Describe what kind of agent you need…" : "Type your message…"}
                  disabled={planningStreaming}
                  className="flex-1 px-3 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent" />
                {planningStreaming ? (
                  <button onClick={() => planningAbortRef.current?.abort()} className="p-2.5 rounded-lg bg-status-error/15 text-status-error hover:bg-status-error/30"><Square size={16} /></button>
                ) : (
                  <button onClick={() => sendToPlanning()} disabled={!planningInput.trim()} className="p-2.5 rounded-lg bg-accent text-white hover:bg-accent/80 disabled:opacity-40"><Send size={16} /></button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Agent edit modal — rendered via portal so it escapes overflow:hidden ancestors */}
      {modalAgent && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={closeModal}>
          <div className="w-full max-w-md bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
              <div className={`w-9 h-9 rounded-full ${agentColor(agents.findIndex(a => a.id === modalAgent.id))} flex items-center justify-center flex-shrink-0`}>
                <span className="text-xs font-bold text-white">{agentInitials(editForm.name || modalAgent.name)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold text-text-primary truncate">{editForm.name || modalAgent.name}</h2>
                {editForm.role && <p className="text-xs text-accent truncate">{editForm.role}</p>}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={chatWithAgent} title="Chat with agent"
                  className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-bg-raised transition-colors">
                  <MessageSquare size={14} />
                </button>
                <button onClick={planWithClaude} title="Plan with Claude"
                  className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-bg-raised transition-colors">
                  <MessageSquarePlus size={14} />
                </button>
                <button onClick={closeModal} className="p-1.5 rounded text-text-muted hover:text-text-primary transition-colors">
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Form */}
            <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-xs text-text-muted mb-1">Name</label>
                <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Agent name" className={modalInputCls} />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Role</label>
                <input value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))}
                  placeholder="e.g. DevOps Engineer" className={modalInputCls} />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Model</label>
                <select value={editForm.modelId} onChange={e => setEditForm(f => ({ ...f, modelId: e.target.value }))}
                  className={modalInputCls}>
                  <option value="human">Human (no AI)</option>
                  {availableModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Description</label>
                <textarea value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                  rows={3} placeholder="Responsibilities & expertise..."
                  className={`${modalInputCls} resize-none`} />
              </div>
              {editForm.modelId !== 'human' && (
                <>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">System Prompt</label>
                    <textarea value={editForm.systemPrompt} onChange={e => setEditForm(f => ({ ...f, systemPrompt: e.target.value }))}
                      rows={5} placeholder="How this agent should behave, its persona, constraints..."
                      className={`${modalInputCls} resize-none border-accent/30 bg-accent/5`} />
                  </div>
                  <div className="rounded-lg border border-border-subtle p-3 space-y-3">
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input type="checkbox" checked={editForm.tools}
                        onChange={e => setEditForm(f => ({ ...f, tools: e.target.checked }))}
                        className="w-3.5 h-3.5 accent-accent" />
                      <span className="text-xs font-medium text-text-primary">ORION tools</span>
                      <span className="text-[10px] text-text-muted">— can create tasks, agents, and more in chat</span>
                    </label>
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input type="checkbox" checked={editForm.persistent}
                        onChange={e => setEditForm(f => ({ ...f, persistent: e.target.checked }))}
                        className="w-3.5 h-3.5 accent-accent" />
                      <span className="text-xs font-medium text-text-primary">Persistent watcher</span>
                      <span className="text-[10px] text-text-muted">— runs on a schedule, not assigned tasks</span>
                    </label>
                    {editForm.persistent && (
                      <>
                        <div>
                          <label className="block text-xs text-text-muted mb-1">Watch interval (minutes)</label>
                          <input type="number" min={1} max={1440} value={editForm.watchIntervalMin}
                            onChange={e => setEditForm(f => ({ ...f, watchIntervalMin: parseInt(e.target.value) || 60 }))}
                            className={modalInputCls} />
                        </div>
                        <div>
                          <label className="block text-xs text-text-muted mb-1">Watch prompt <span className="text-text-muted">(what to check each cycle)</span></label>
                          <textarea value={editForm.watchPrompt}
                            onChange={e => setEditForm(f => ({ ...f, watchPrompt: e.target.value }))}
                            rows={3} placeholder="Check for any pods in CrashLoopBackOff and report them to the Agent Feed..."
                            className={`${modalInputCls} resize-none`} />
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-5 py-4 border-t border-border-subtle">
              <button onClick={handleDelete}
                className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                  confirmDelete
                    ? 'border-status-error bg-status-error/10 text-status-error'
                    : 'border-border-subtle text-text-muted hover:border-status-error hover:text-status-error'
                }`}>
                <Trash2 size={12} className="inline mr-1" />
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </button>
              <div className="flex-1" />
              <button onClick={closeModal}
                className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button onClick={saveEdit} disabled={!editForm.name.trim() || saving}
                className="px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Nebula browser panel — slides in from the right */}
      {showNovaBrowser && createPortal(
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setShowNovaBrowser(false)}>
          <div className="w-80 h-full bg-bg-sidebar border-l border-border-subtle shadow-xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
              <span className="text-xs font-semibold text-text-primary">Nebula Catalog</span>
              <button onClick={() => setShowNovaBrowser(false)} className="text-text-muted hover:text-text-primary">
                <X size={14} />
              </button>
            </div>
            <NovaBrowser onImport={handleNovaImport} />
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
