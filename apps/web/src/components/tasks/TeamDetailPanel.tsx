'use client'
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { X, Plus, Trash2, Bot, User, Cpu, MessageSquarePlus, MessageSquare } from 'lucide-react'
import type { Agent } from '@/types/tasks'

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
}

const DEFAULT_MODEL = 'claude:claude-sonnet-4-6'
const emptyForm: AgentForm = { name: '', modelId: DEFAULT_MODEL, role: '', description: '', systemPrompt: '', persistent: false, watchPrompt: '', watchIntervalMin: 60 }

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
  const [saving, setSaving]             = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<{id: string; name: string; provider: string; builtIn: boolean}>>([])
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

  const createWithClaude = async () => {
    const tmplRes = await fetch('/api/admin/prompts/context.agent-create')
    const initialContext = tmplRes.ok
      ? ((await tmplRes.json() as { content: string }).content)
      : "I want to create a new agent for my homelab team. Help me define what this agent should do. Ask me what kind of agent I need, its responsibilities, and if it's an AI agent, help me write a good system prompt for it."
    const r = await fetch('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Agent', agentDraft: true, initialContext }),
    })
    const convo = await r.json()
    router.push(`/chat?conversation=${convo.id}`)
  }

  const openCreate = () => { setForm(emptyForm); setCreateModal(true) }
  const closeCreate = () => { setCreateModal(false); setForm(emptyForm) }

  const create = async () => {
    if (!form.name.trim()) return
    setSaving(true)
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
          contextConfig: { llm: form.modelId },
        } : undefined,
      }),
    })
    const agent: Agent = await r.json()
    if (onCreate) onCreate(agent)
    else setLocalAgents(prev => [...prev, agent])
    setCreateModal(false)
    setForm(emptyForm)
    setSaving(false)
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
          <button onClick={createWithClaude}
            className="flex items-center gap-2 px-4 py-2.5 text-xs text-text-muted hover:text-accent hover:bg-bg-raised transition-colors border-l border-border-subtle"
            title="Start a conversation to plan the agent with Claude">
            <MessageSquarePlus size={13} /> Create with Claude
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
                <div>
                  <label className="block text-xs text-text-muted mb-1">System Prompt</label>
                  <textarea value={form.systemPrompt} onChange={e => setForm(f => ({ ...f, systemPrompt: e.target.value }))}
                    rows={4} placeholder="How this agent should behave, its persona, constraints..."
                    className="w-full px-3 py-2 text-sm rounded border border-accent/30 bg-accent/5 text-text-primary resize-none focus:outline-none focus:border-accent" />
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
              <button onClick={closeCreate} className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                Cancel
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
    </>
  )
}
