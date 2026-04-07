'use client'
import { useRef, useState } from 'react'
import { Plus, MessageSquare, Trash2, Pencil, Check, X, ChevronRight, ChevronDown, GitBranch, Layers, Bot, Bug } from 'lucide-react'

interface Conversation {
  id: string
  title: string | null
  createdAt: string
  _count: { messages: number }
}

interface PlanningConvo {
  id: string
  title: string | null
  metadata: { planTarget: { type: string; id: string } }
}

interface Feature {
  id: string
  title: string
}

interface Epic {
  id: string
  title: string
  features: Feature[]
}

interface AgentConvo {
  id: string
  title: string | null
  metadata: { agentTarget?: { id: string; name: string }; agentChat?: { id: string; name: string }; agentDraft?: boolean }
}

interface DebugConvo {
  id: string
  title: string | null
}

interface Agent {
  id: string
  name: string
}

interface Props {
  convos: Conversation[]
  planningConvos?: PlanningConvo[]
  agentConvos?: AgentConvo[]
  debugConvos?: DebugConvo[]
  epics?: Epic[]
  agents?: Agent[]
  onSelect?: (id: string) => void
  activeId?: string
  onDelete?: (id: string) => void
  onRename?: (id: string, title: string) => void
  onMobileSelect?: () => void
}

export function ConversationList({ convos, planningConvos = [], agentConvos = [], debugConvos = [], epics = [], agents = [], onSelect, activeId, onDelete, onRename, onMobileSelect }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Planning tree expand state
  const [planningOpen, setPlanningOpen] = useState(true)
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())

  // Agent chats tree expand state
  const [agentChatsOpen, setAgentChatsOpen] = useState(true)
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set())

  // Debug chats expand state
  const [debugChatsOpen, setDebugChatsOpen] = useState(true)

  const toggleAgent = (id: string) => setExpandedAgents(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const toggleEpic = (id: string) => setExpandedEpics(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  // Build lookup: targetId → planning convos
  const convosByTarget = planningConvos.reduce<Record<string, PlanningConvo[]>>((acc, c) => {
    const id = c.metadata.planTarget.id
    ;(acc[id] ??= []).push(c)
    return acc
  }, {})

  // Epics that have at least one planning convo
  const epicsWithConvos = epics.filter(e => {
    const hasEpicConvos = (convosByTarget[e.id]?.length ?? 0) > 0
    const hasFeatureConvos = e.features.some(f => (convosByTarget[f.id]?.length ?? 0) > 0)
    return hasEpicConvos || hasFeatureConvos
  })

  // Unorganized planning convos (not matching any known epic/feature)
  const organizedIds = new Set([
    ...epics.map(e => e.id),
    ...epics.flatMap(e => e.features.map(f => f.id)),
  ])
  const orphanConvos = planningConvos.filter(c => !organizedIds.has(c.metadata.planTarget.id))

  const remove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' })
    onDelete?.(id)
  }

  const startEdit = (e: React.MouseEvent, convo: Conversation) => {
    e.stopPropagation()
    setEditingId(convo.id)
    setEditValue(convo.title ?? '')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const commitEdit = async (id: string) => {
    const title = editValue.trim() || null
    await fetch(`/api/chat/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    onRename?.(id, title ?? '')
    setEditingId(null)
  }

  const cancelEdit = () => setEditingId(null)

  const onEditKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(id) }
    if (e.key === 'Escape') cancelEdit()
  }

  const rowBase = 'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors select-none'
  const activeRow = 'bg-accent/10 border-r-2 border-accent text-text-primary'
  const idleRow = 'text-text-muted hover:bg-bg-raised hover:text-text-primary'

  return (
    <aside className="w-full md:w-56 h-full flex-shrink-0 flex flex-col border-r border-border-subtle bg-bg-sidebar overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border-subtle flex-shrink-0">
        <span className="text-xs font-semibold text-text-secondary">Conversations</span>
        <button onClick={() => { onSelect?.(''); onMobileSelect?.() }} className="p-1 rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors" title="New conversation">
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Regular conversations */}
        {convos.length === 0 && planningConvos.length === 0 && (
          <p className="px-3 py-4 text-xs text-text-muted">No conversations yet. Send a message to start.</p>
        )}
        {convos.map(c => (
          <div
            key={c.id}
            className={`group w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-bg-raised transition-colors cursor-pointer ${activeId === c.id ? 'bg-accent/10 border-r-2 border-accent' : ''}`}
            onClick={() => { if (editingId !== c.id) { onSelect?.(c.id); onMobileSelect?.() } }}
          >
            <MessageSquare size={14} className="flex-shrink-0 mt-0.5 text-text-muted" />
            <div className="min-w-0 flex-1">
              {editingId === c.id ? (
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => onEditKeyDown(e, c.id)}
                    onBlur={() => commitEdit(c.id)}
                    className="flex-1 min-w-0 text-xs bg-bg-raised border border-accent rounded px-1 py-0.5 text-text-primary focus:outline-none"
                  />
                  <button onClick={() => commitEdit(c.id)} className="text-green-400 hover:text-green-300 flex-shrink-0"><Check size={11} /></button>
                  <button onClick={cancelEdit} className="text-text-muted hover:text-red-400 flex-shrink-0"><X size={11} /></button>
                </div>
              ) : (
                <>
                  <p className="text-xs text-text-primary truncate">{c.title || 'New conversation'}</p>
                  <p className="text-[10px] text-text-muted">{c._count.messages} msg</p>
                </>
              )}
            </div>
            {editingId !== c.id && (
              <div className="flex-shrink-0 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                <button onClick={(e) => startEdit(e, c)} className="p-0.5 rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors">
                  <Pencil size={11} />
                </button>
                <button onClick={(e) => remove(e, c.id)} className="p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors">
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          </div>
        ))}

        {/* Planning Chats tree */}
        {planningConvos.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t border-border-subtle" />

            {/* Section header */}
            <div
              onClick={() => setPlanningOpen(p => !p)}
              className={`${rowBase} text-text-muted hover:text-text-primary font-medium`}
            >
              {planningOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Layers size={12} className="flex-shrink-0 text-accent" />
              <span className="flex-1">Planning Chats</span>
              <span className="text-[10px] text-text-muted">{planningConvos.length}</span>
            </div>

            {planningOpen && (
              <>
                {/* Organized by epic */}
                {epicsWithConvos.map(epic => {
                  const epicConvos = convosByTarget[epic.id] ?? []
                  const isOpen = expandedEpics.has(epic.id)
                  return (
                    <div key={epic.id}>
                      <div
                        onClick={() => toggleEpic(epic.id)}
                        className={`${rowBase} text-text-muted hover:text-text-primary ml-2`}
                      >
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="flex-1 truncate text-[11px]">{epic.title}</span>
                      </div>
                      {isOpen && (
                        <div className="ml-4 border-l border-border-subtle pl-2">
                          {/* Epic-level planning convos */}
                          {epicConvos.map(c => (
                            <div
                              key={c.id}
                              onClick={() => { onSelect?.(c.id); onMobileSelect?.() }}
                              className={`${rowBase} gap-1.5 ${activeId === c.id ? activeRow : idleRow}`}
                              title={c.title ?? undefined}
                            >
                              <MessageSquare size={10} className="flex-shrink-0" />
                              <span className="flex-1 truncate text-[10px]">{c.title ?? 'Planning chat'}</span>
                            </div>
                          ))}
                          {/* Feature-level planning convos */}
                          {epic.features.map(f => {
                            const fConvos = convosByTarget[f.id] ?? []
                            if (fConvos.length === 0) return null
                            return (
                              <div key={f.id}>
                                <div className="flex items-center gap-1.5 px-3 py-0.5 text-[9px] text-text-muted uppercase tracking-wide">
                                  <GitBranch size={9} />
                                  <span className="truncate">{f.title}</span>
                                </div>
                                {fConvos.map(c => (
                                  <div
                                    key={c.id}
                                    onClick={() => { onSelect?.(c.id); onMobileSelect?.() }}
                                    className={`${rowBase} gap-1.5 ml-2 ${activeId === c.id ? activeRow : idleRow}`}
                                    title={c.title ?? undefined}
                                  >
                                    <MessageSquare size={10} className="flex-shrink-0" />
                                    <span className="flex-1 truncate text-[10px]">{c.title ?? 'Planning chat'}</span>
                                  </div>
                                ))}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Orphan planning convos (no matching epic/feature) */}
                {orphanConvos.map(c => (
                  <div
                    key={c.id}
                    onClick={() => onSelect?.(c.id)}
                    className={`${rowBase} gap-1.5 ml-2 ${activeId === c.id ? activeRow : idleRow}`}
                    title={c.title ?? undefined}
                  >
                    <MessageSquare size={10} className="flex-shrink-0" />
                    <span className="flex-1 truncate text-[10px]">{c.title ?? 'Planning chat'}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        {/* Agent Chats tree */}
        {agentConvos.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t border-border-subtle" />

            <div
              onClick={() => setAgentChatsOpen(p => !p)}
              className={`${rowBase} text-text-muted hover:text-text-primary font-medium`}
            >
              {agentChatsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Bot size={12} className="flex-shrink-0 text-accent" />
              <span className="flex-1">Agent Chats</span>
              <span className="text-[10px] text-text-muted">{agentConvos.length}</span>
            </div>

            {agentChatsOpen && (() => {
              // Split drafts from agent-linked convos
              const draftConvos = agentConvos.filter(c => c.metadata.agentDraft && !c.metadata.agentTarget && !c.metadata.agentChat)
              const linkedConvos = agentConvos.filter(c => !!c.metadata.agentTarget || !!c.metadata.agentChat)

              // Group by agent id (both planning + chat convos under same agent)
              const convosByAgent = linkedConvos.reduce<Record<string, AgentConvo[]>>((acc, c) => {
                const id = (c.metadata.agentTarget ?? c.metadata.agentChat)!.id
                ;(acc[id] ??= []).push(c)
                return acc
              }, {})

              // Known agents that have convos
              const agentsWithConvos = agents.filter(a => (convosByAgent[a.id]?.length ?? 0) > 0)
              // Orphan convos (agent deleted or not in list)
              const knownAgentIds = new Set(agents.map(a => a.id))
              const orphans = linkedConvos.filter(c => !knownAgentIds.has((c.metadata.agentTarget ?? c.metadata.agentChat)!.id))

              return (
                <>
                  {draftConvos.map(c => (
                    <div
                      key={c.id}
                      onClick={() => { onSelect?.(c.id); onMobileSelect?.() }}
                      className={`group ${rowBase} gap-1.5 ml-2 ${activeId === c.id ? activeRow : idleRow}`}
                    >
                      <MessageSquare size={10} className="flex-shrink-0" />
                      <span className="flex-1 truncate text-[10px]">{c.title ?? 'New agent draft'}</span>
                      <span className="text-[9px] text-text-muted italic group-hover:hidden">draft</span>
                      <button onClick={e => { e.stopPropagation(); remove(e, c.id) }}
                        className="hidden group-hover:block p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors flex-shrink-0">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                  {agentsWithConvos.map(agent => {
                    const convs = convosByAgent[agent.id] ?? []
                    const isOpen = expandedAgents.has(agent.id)
                    return (
                      <div key={agent.id}>
                        <div
                          onClick={() => toggleAgent(agent.id)}
                          className={`${rowBase} text-text-muted hover:text-text-primary ml-2`}
                        >
                          {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          <span className="flex-1 truncate text-[11px]">{agent.name}</span>
                          <span className="text-[9px] text-text-muted">{convs.length}</span>
                        </div>
                        {isOpen && (
                          <div className="ml-4 border-l border-border-subtle pl-2">
                            {convs.map(c => (
                              <div
                                key={c.id}
                                onClick={() => { onSelect?.(c.id); onMobileSelect?.() }}
                                className={`group ${rowBase} gap-1.5 ${activeId === c.id ? activeRow : idleRow}`}
                                title={c.title ?? undefined}
                              >
                                <MessageSquare size={10} className="flex-shrink-0" />
                                <span className="flex-1 truncate text-[10px]">{c.title ?? (c.metadata.agentChat ? 'Chat' : 'Plan')}</span>
                                <span className="text-[9px] text-text-muted group-hover:hidden">{c.metadata.agentChat ? 'chat' : 'plan'}</span>
                                <button onClick={e => { e.stopPropagation(); remove(e, c.id) }}
                                  className="hidden group-hover:block p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors flex-shrink-0">
                                  <Trash2 size={10} />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {orphans.map(c => (
                    <div
                      key={c.id}
                      onClick={() => { onSelect?.(c.id); onMobileSelect?.() }}
                      className={`group ${rowBase} gap-1.5 ml-2 ${activeId === c.id ? activeRow : idleRow}`}
                      title={c.title ?? undefined}
                    >
                      <MessageSquare size={10} className="flex-shrink-0" />
                      <span className="flex-1 truncate text-[10px]">{c.title ?? (c.metadata.agentChat ?? c.metadata.agentTarget)!.name}</span>
                      <button onClick={e => { e.stopPropagation(); remove(e, c.id) }}
                        className="hidden group-hover:block p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors flex-shrink-0">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </>
              )
            })()}
          </>
        )}
        {/* Debug Chats section */}
        {debugConvos.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t border-border-subtle" />

            <div
              onClick={() => setDebugChatsOpen(p => !p)}
              className={`${rowBase} text-text-muted hover:text-text-primary font-medium`}
            >
              {debugChatsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Bug size={12} className="flex-shrink-0 text-accent" />
              <span className="flex-1">Debug Chats</span>
              <span className="text-[10px] text-text-muted">{debugConvos.length}</span>
            </div>

            {debugChatsOpen && debugConvos.map(c => (
              <div
                key={c.id}
                onClick={() => { onSelect?.(c.id); onMobileSelect?.() }}
                className={`group ${rowBase} gap-1.5 ml-2 ${activeId === c.id ? activeRow : idleRow}`}
                title={c.title ?? undefined}
              >
                <MessageSquare size={10} className="flex-shrink-0" />
                <span className="flex-1 truncate text-[10px]">{c.title ?? 'Debug chat'}</span>
                <button onClick={e => { e.stopPropagation(); remove(e, c.id) }}
                  className="hidden group-hover:block p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors flex-shrink-0">
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
