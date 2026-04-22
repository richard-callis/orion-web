'use client'
import { useRef, useState, useEffect, useCallback } from 'react'
import {
  Plus, MessageSquare, Trash2, Pencil, Check, X,
  ChevronRight, ChevronDown, GitBranch, Layers, Bot, Bug, Users, Hash,
} from 'lucide-react'

// ── Conversation types ──────────────────────────────────────────
interface Conversation {
  id: string
  title: string | null
  createdAt: string
  _count: { messages: number }
  metadata?: {
    planTarget?: { type: string; id: string }
    agentTarget?: { id: string; name: string }
    agentChat?: { id: string; name: string }
    agentDraft?: boolean
    debugChat?: boolean
  } | null
}

interface PlanningConvo { id: string; title: string | null; metadata: { planTarget: { type: string; id: string } } }
interface AgentConvo { id: string; title: string | null; metadata: { agentTarget?: { id: string; name: string }; agentChat?: { id: string; name: string }; agentDraft?: boolean } }
interface DebugConvo { id: string; title: string | null }

interface EpicsFeature { id: string; title: string; features: { id: string; title: string }[] }
interface Agent { id: string; name: string }
interface Environment { id: string; name: string }

// ── Room types ──────────────────────────────────────────────────
interface Room {
  id: string
  name: string
  type: string
  created_at: string
  _count: { messages: number; members: number }
  task?: { id: string; title: string } | null
}

// ── Props ───────────────────────────────────────────────────────
interface Props {
  view: 'ai' | 'rooms' | 'all'
  onSelect: (id: string) => void
  activeId?: string
  onMobileSelect?: () => void
  onCreateNew?: () => void
  // AI data
  convos?: Conversation[]
  planningConvos?: PlanningConvo[]
  agentConvos?: AgentConvo[]
  debugConvos?: DebugConvo[]
  epics?: EpicsFeature[]
  agents?: Agent[]
  // Room data
  rooms?: Room[]
  roomFilter?: string
  onRoomFilterChange?: (f: string) => void
}

const TYPE_COLORS: Record<string, string> = {
  task: 'bg-blue-500/20 text-blue-400',
  feature: 'bg-purple-500/20 text-purple-400',
  general: 'bg-gray-500/20 text-gray-400',
  ops: 'bg-orange-500/20 text-orange-400',
}

export function MessageList({
  view, onSelect, activeId, onMobileSelect, onCreateNew,
  convos = [], planningConvos = [], agentConvos = [], debugConvos = [],
  epics = [], agents = [],
  rooms = [], roomFilter, onRoomFilterChange,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [planningOpen, setPlanningOpen] = useState(true)
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())
  const [agentChatsOpen, setAgentChatsOpen] = useState(true)
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set())
  const [debugChatsOpen, setDebugChatsOpen] = useState(true)
  const [roomListFilter, setRoomListFilter] = useState(roomFilter ?? '')

  const effectiveRoomFilter = roomFilter ?? roomListFilter
  const setRoomFilter = onRoomFilterChange ?? setRoomListFilter

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

  const convosByTarget = planningConvos.reduce<Record<string, PlanningConvo[]>>((acc, c) => {
    const id = c.metadata.planTarget.id
    ;(acc[id] ??= []).push(c)
    return acc
  }, {})

  const epicsWithConvos = epics.filter(e => {
    const hasEpicConvos = (convosByTarget[e.id]?.length ?? 0) > 0
    const hasFeatureConvos = e.features.some(f => (convosByTarget[f.id]?.length ?? 0) > 0)
    return hasEpicConvos || hasFeatureConvos
  })

  const organizedIds = new Set([...epics.map(e => e.id), ...epics.flatMap(e => e.features.map(f => f.id))])
  const orphanConvos = planningConvos.filter(c => !organizedIds.has(c.metadata.planTarget.id))

  const removeConvo = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' })
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
    setEditingId(null)
  }

  const cancelEdit = () => setEditingId(null)
  const onEditKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(id) }
    if (e.key === 'Escape') cancelEdit()
  }

  const rowBase = 'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer select-none'
  const activeRow = 'bg-accent/10 border-l-2 border-l-accent text-text-primary'
  const idleRow = 'text-text-muted hover:bg-bg-raised hover:text-text-primary'

  const filteredRooms = effectiveRoomFilter ? rooms.filter(r => r.type === effectiveRoomFilter) : rooms

  // ── Render helpers ────────────────────────────────────────────
  const renderConversation = (c: Conversation) => (
    <div
      key={c.id}
      className={`group w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${activeId === c.id ? 'bg-accent/10 border-l-2 border-l-accent' : 'hover:bg-bg-raised'}`}
      onClick={() => { if (editingId !== c.id) { onSelect(`c_${c.id}`); onMobileSelect?.() } }}
    >
      <MessageSquare size={14} className="flex-shrink-0 mt-0.5 text-text-muted" />
      <div className="min-w-0 flex-1">
        {editingId === c.id ? (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <input ref={inputRef} value={editValue} onChange={e => setEditValue(e.target.value)} onKeyDown={e => onEditKeyDown(e, c.id)} onBlur={() => commitEdit(c.id)} className="flex-1 min-w-0 text-xs bg-bg-raised border border-accent rounded px-1 py-0.5 text-text-primary focus:outline-none" />
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
          <button onClick={(e) => startEdit(e, c)} className="p-0.5 rounded text-text-muted hover:text-accent hover:bg-accent/10"><Pencil size={11} /></button>
          <button onClick={(e) => removeConvo(e, c.id)} className="p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10"><Trash2 size={11} /></button>
        </div>
      )}
    </div>
  )

  const renderRoom = (room: Room) => (
    <button
      key={room.id}
      className={`w-full text-left px-4 py-3 border-b border-border-subtle transition-colors ${activeId === `r_${room.id}` ? 'bg-accent/10 border-l-2 border-l-accent' : 'hover:bg-bg-raised'}`}
      onClick={() => { onSelect(`r_${room.id}`); onMobileSelect?.() }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Hash size={12} className="text-text-muted" />
        <span className="text-xs font-medium text-text-primary truncate">{room.name}</span>
        <span className={`ml-auto px-1.5 py-0.5 rounded text-[9px] flex-shrink-0 ${TYPE_COLORS[room.type] || TYPE_COLORS.general}`}>{room.type}</span>
      </div>
      <div className="flex items-center gap-2 ml-4">
        <span className="text-[10px] text-text-muted">{room._count.messages} msgs</span>
        <span className="text-[10px] text-text-muted flex items-center gap-0.5"><Users size={10} /> {room._count.members}</span>
      </div>
      {room.task && <div className="ml-4 text-[10px] text-accent mt-0.5 truncate">linked: {room.task.title}</div>}
    </button>
  )

  // ── AI-only sections ─────────────────────────────────────────
  const renderAISections = () => {
    const regularConvos = convos.filter(c => !c.metadata?.planTarget && !c.metadata?.agentTarget && !c.metadata?.agentChat && !c.metadata?.agentDraft && !c.metadata?.debugChat)

    return (
      <>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-border-subtle flex-shrink-0">
          <span className="text-xs font-semibold text-text-secondary">AI Chats</span>
          <button onClick={onCreateNew} className="p-1 rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors" title="New conversation">
            <Plus size={14} />
          </button>
        </div>

        {/* Regular conversations */}
        {regularConvos.length === 0 && planningConvos.length === 0 && (
          <p className="px-3 py-4 text-xs text-text-muted">No conversations yet. Send a message to start.</p>
        )}
        {regularConvos.map(renderConversation)}

        {/* Planning Chats */}
        {planningConvos.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t border-border-subtle" />
            <div onClick={() => setPlanningOpen(p => !p)} className={`${rowBase} text-text-muted hover:text-text-primary font-medium px-3 py-1`}>
              {planningOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Layers size={12} className="flex-shrink-0 text-accent" />
              <span className="flex-1">Planning Chats</span>
              <span className="text-[10px] text-text-muted">{planningConvos.length}</span>
            </div>
            {planningOpen && (
              <>
                {epicsWithConvos.map(epic => {
                  const epicConvos = convosByTarget[epic.id] ?? []
                  const isOpen = expandedEpics.has(epic.id)
                  return (
                    <div key={epic.id}>
                      <div onClick={() => toggleEpic(epic.id)} className={`${rowBase} text-text-muted hover:text-text-primary ml-2`}>
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="flex-1 truncate text-[11px]">{epic.title}</span>
                      </div>
                      {isOpen && (
                        <div className="ml-4 border-l border-border-subtle pl-2">
                          {epicConvos.map(c => (
                            <div key={c.id} onClick={() => onSelect(`c_${c.id}`)} className={`${rowBase} gap-1.5 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
                              <MessageSquare size={10} className="flex-shrink-0" />
                              <span className="flex-1 truncate text-[10px]">{c.title ?? 'Planning chat'}</span>
                            </div>
                          ))}
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
                                  <div key={c.id} onClick={() => onSelect(`c_${c.id}`)} className={`${rowBase} gap-1.5 ml-2 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
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
                {orphanConvos.map(c => (
                  <div key={c.id} onClick={() => onSelect(`c_${c.id}`)} className={`${rowBase} gap-1.5 ml-2 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
                    <MessageSquare size={10} className="flex-shrink-0" />
                    <span className="flex-1 truncate text-[10px]">{c.title ?? 'Planning chat'}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {/* Agent Chats */}
        {agentConvos.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t border-border-subtle" />
            <div onClick={() => setAgentChatsOpen(p => !p)} className={`${rowBase} text-text-muted hover:text-text-primary font-medium px-3 py-1`}>
              {agentChatsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Bot size={12} className="flex-shrink-0 text-accent" />
              <span className="flex-1">Agent Chats</span>
              <span className="text-[10px] text-text-muted">{agentConvos.length}</span>
            </div>
            {agentChatsOpen && (() => {
              const draftConvos = agentConvos.filter(c => c.metadata.agentDraft && !c.metadata.agentTarget && !c.metadata.agentChat)
              const linkedConvos = agentConvos.filter(c => !!c.metadata.agentTarget || !!c.metadata.agentChat)
              const convosByAgent = linkedConvos.reduce<Record<string, AgentConvo[]>>((acc, c) => {
                const id = (c.metadata.agentTarget ?? c.metadata.agentChat)!.id
                ;(acc[id] ??= []).push(c)
                return acc
              }, {})
              const agentsWithConvos = agents.filter(a => (convosByAgent[a.id]?.length ?? 0) > 0)
              const knownAgentIds = new Set(agents.map(a => a.id))
              const orphans = linkedConvos.filter(c => !knownAgentIds.has((c.metadata.agentTarget ?? c.metadata.agentChat)!.id))

              return (
                <>
                  {draftConvos.map(c => (
                    <div key={c.id} onClick={() => onSelect(`c_${c.id}`)} className={`group ${rowBase} gap-1.5 ml-2 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
                      <MessageSquare size={10} className="flex-shrink-0" />
                      <span className="flex-1 truncate text-[10px]">{c.title ?? 'New agent draft'}</span>
                      <span className="text-[9px] text-text-muted italic group-hover:hidden">draft</span>
                      <button onClick={(e) => { e.stopPropagation(); removeConvo(e, c.id) }} className="hidden group-hover:block p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 flex-shrink-0"><Trash2 size={10} /></button>
                    </div>
                  ))}
                  {agentsWithConvos.map(agent => {
                    const convs = convosByAgent[agent.id] ?? []
                    const isOpen = expandedAgents.has(agent.id)
                    return (
                      <div key={agent.id}>
                        <div onClick={() => toggleAgent(agent.id)} className={`${rowBase} text-text-muted hover:text-text-primary ml-2`}>
                          {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          <span className="flex-1 truncate text-[11px]">{agent.name}</span>
                          <span className="text-[9px] text-text-muted">{convs.length}</span>
                        </div>
                        {isOpen && (
                          <div className="ml-4 border-l border-border-subtle pl-2">
                            {convs.map(c => (
                              <div key={c.id} onClick={() => onSelect(`c_${c.id}`)} className={`group ${rowBase} gap-1.5 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
                                <MessageSquare size={10} className="flex-shrink-0" />
                                <span className="flex-1 truncate text-[10px]">{c.title ?? (c.metadata.agentChat ? 'Chat' : 'Plan')}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {orphans.map(c => (
                    <div key={c.id} onClick={() => onSelect(`c_${c.id}`)} className={`group ${rowBase} gap-1.5 ml-2 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
                      <MessageSquare size={10} className="flex-shrink-0" />
                      <span className="flex-1 truncate text-[10px]">{c.title ?? 'Chat'}</span>
                    </div>
                  ))}
                </>
              )
            })()}
          </>
        )}

        {/* Debug Chats */}
        {debugConvos.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t border-border-subtle" />
            <div onClick={() => setDebugChatsOpen(p => !p)} className={`${rowBase} text-text-muted hover:text-text-primary font-medium px-3 py-1`}>
              {debugChatsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Bug size={12} className="flex-shrink-0 text-accent" />
              <span className="flex-1">Debug Chats</span>
              <span className="text-[10px] text-text-muted">{debugConvos.length}</span>
            </div>
            {debugChatsOpen && debugConvos.map(c => (
              <div key={c.id} onClick={() => onSelect(`c_${c.id}`)} className={`group ${rowBase} gap-1.5 ml-2 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
                <MessageSquare size={10} className="flex-shrink-0" />
                <span className="flex-1 truncate text-[10px]">{c.title ?? 'Debug chat'}</span>
                <button onClick={(e) => { e.stopPropagation(); removeConvo(e, c.id) }} className="hidden group-hover:block p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 flex-shrink-0"><Trash2 size={10} /></button>
              </div>
            ))}
          </>
        )}
      </>
    )
  }

  const renderRoomSections = () => (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border-subtle flex-shrink-0">
        <span className="text-xs font-semibold text-text-secondary">Chat Rooms</span>
        <button onClick={onCreateNew} className="p-1 rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors" title="New room">
          <Plus size={14} />
        </button>
      </div>

      {/* Filter chips */}
      <div className="px-3 py-2 border-b border-border-subtle">
        <div className="flex items-center gap-1 flex-wrap">
          <button onClick={() => setRoomFilter('')} className={`px-2 py-0.5 rounded text-[10px] ${!effectiveRoomFilter ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'}`}>All</button>
          {['task', 'feature', 'general', 'ops'].map(t => (
            <button key={t} onClick={() => setRoomFilter(effectiveRoomFilter === t ? '' : t)} className={`px-2 py-0.5 rounded text-[10px] capitalize ${effectiveRoomFilter === t ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'}`}>{t}</button>
          ))}
        </div>
      </div>

      {/* Room list */}
      {filteredRooms.length === 0 ? (
        <div className="p-4 text-center text-text-muted text-xs">No chat rooms yet.</div>
      ) : (
        filteredRooms.map(renderRoom)
      )}
    </>
  )

  // ── Main render ───────────────────────────────────────────────
  return (
    <aside className="w-full md:w-56 lg:w-64 h-full flex-shrink-0 flex flex-col border-r border-border-subtle bg-bg-sidebar overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {view === 'all' ? (
          <>
            {renderAISections()}
            {/* Separator */}
            <div className="mx-3 my-1 border-t border-border-subtle" />
            {renderRoomSections()}
          </>
        ) : view === 'ai' ? (
          renderAISections()
        ) : (
          renderRoomSections()
        )}
      </div>
    </aside>
  )
}
