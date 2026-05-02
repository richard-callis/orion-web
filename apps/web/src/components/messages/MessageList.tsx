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
  epicId?: string | null
  featureId?: string | null
  epic?: { id: string; title: string } | null
  feature?: { id: string; title: string } | null
  created_at: string
  _count: { messages: number; members: number }
  task?: { id: string; title: string } | null
}

// ── Props ───────────────────────────────────────────────────────
interface Props {
  view: 'ai' | 'rooms'
  onSelect: (id: string) => void
  activeId?: string
  onMobileSelect?: () => void
  onCreateNew?: () => void
  onDelete?: (prefixedId: string) => void
  onRename?: (id: string, title: string) => void
  onRoomUpdate?: (id: string, patch: { name?: string; type?: string }) => void
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
  task:     'bg-blue-500/20 text-blue-400',
  feature:  'bg-purple-500/20 text-purple-400',
  general:  'bg-gray-500/20 text-gray-400',
  ops:      'bg-orange-500/20 text-orange-400',
  planning: 'bg-teal-500/20 text-teal-400',
}

const ROOM_TYPES = ['general', 'ops', 'planning', 'feature', 'task'] as const

export function MessageList({
  view, onSelect, activeId, onMobileSelect, onCreateNew, onDelete, onRename, onRoomUpdate,
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

  const epicsWithConvos = (epics ?? []).filter(e => {
    const hasEpicConvos = (convosByTarget[e.id]?.length ?? 0) > 0
    const hasFeatureConvos = e.features.some(f => (convosByTarget[f.id]?.length ?? 0) > 0)
    return hasEpicConvos || hasFeatureConvos
  })

  const organizedIds = new Set([...(epics ?? []).map(e => e.id), ...(epics ?? []).flatMap(e => e.features.map(f => f.id))])
  const orphanConvos = (planningConvos ?? []).filter(c => !organizedIds.has(c.metadata.planTarget.id))

  const removeConvo = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' })
    onDelete?.(`c_${id}`)
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

  const rowBase = 'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer select-none'
  const activeRow = 'bg-accent/10 border-l-2 border-l-accent text-text-primary'
  const idleRow = 'text-text-muted hover:bg-bg-raised hover:text-text-primary'

  const filteredRooms = effectiveRoomFilter ? (rooms ?? []).filter(r => r.type === effectiveRoomFilter) : (rooms ?? [])

  // ── Render helpers ────────────────────────────────────────────
  const renderConversation = (c: Conversation) => (
    <div
      key={c.id}
      className={`group w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${activeId === `c_${c.id}` ? 'bg-accent/10 border-l-2 border-l-accent' : 'hover:bg-bg-raised'}`}
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

  const [editingRoomId, setEditingRoomId] = useState<string | null>(null)
  const [editRoomValue, setEditRoomValue] = useState('')
  const [editRoomType, setEditRoomType] = useState('')
  const roomInputRef = useRef<HTMLInputElement>(null)

  const startRoomEdit = (e: React.MouseEvent, room: Room) => {
    e.stopPropagation()
    setEditingRoomId(room.id)
    setEditRoomValue(room.name)
    setEditRoomType(room.type)
    setTimeout(() => roomInputRef.current?.focus(), 0)
  }

  const commitRoomEdit = async (id: string, currentRoom?: Room) => {
    const name = editRoomValue.trim()
    const payload: Record<string, string> = {}
    if (name && name !== currentRoom?.name) payload.name = name
    if (currentRoom && editRoomType !== currentRoom.type) payload.type = editRoomType
    if (Object.keys(payload).length > 0) {
      await fetch(`/api/chatrooms/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      onRoomUpdate?.(id, payload)
      if (payload.name) onRename?.(id, payload.name)
    }
    setEditingRoomId(null)
  }

  const deleteRoom = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!confirm('Delete this chat room and all its messages?')) return
    await fetch(`/api/chatrooms/${id}`, { method: 'DELETE' })
    onDelete?.(`r_${id}`)
  }

  const renderRoom = (room: Room, indent = false) => (
    <div
      key={room.id}
      className={`group w-full text-left border-b border-border-subtle transition-colors ${indent ? 'pl-5' : ''} ${activeId === `r_${room.id}` ? 'bg-accent/10 border-l-2 border-l-accent' : 'hover:bg-bg-raised'}`}
      onClick={() => { if (editingRoomId !== room.id) { onSelect(`r_${room.id}`); onMobileSelect?.() } }}
    >
      <div className="flex items-center gap-1.5 px-3 py-2">
        <Hash size={11} className="text-text-muted flex-shrink-0" />
        {editingRoomId === room.id ? (
          <div className="flex flex-col gap-1 flex-1 min-w-0" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-1">
              <input ref={roomInputRef} value={editRoomValue} onChange={e => setEditRoomValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commitRoomEdit(room.id, room); if (e.key === 'Escape') setEditingRoomId(null) }}
                className="flex-1 min-w-0 text-xs bg-bg-raised border border-accent rounded px-1 py-0.5 text-text-primary focus:outline-none" />
              <button onClick={() => commitRoomEdit(room.id, room)} className="text-green-400 hover:text-green-300 flex-shrink-0"><Check size={11} /></button>
              <button onClick={() => setEditingRoomId(null)} className="text-text-muted hover:text-red-400 flex-shrink-0"><X size={11} /></button>
            </div>
            <select
              value={editRoomType}
              onChange={e => setEditRoomType(e.target.value)}
              className="text-[10px] bg-bg-raised border border-border-subtle rounded px-1 py-0.5 text-text-primary focus:outline-none focus:border-accent"
            >
              {ROOM_TYPES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        ) : (
          <>
            <span className="text-xs text-text-primary truncate flex-1">{room.name}</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] flex-shrink-0 ${TYPE_COLORS[room.type] || TYPE_COLORS.general}`}>{room.type}</span>
            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
              <button onClick={e => startRoomEdit(e, room)} className="p-0.5 rounded text-text-muted hover:text-accent hover:bg-accent/10"><Pencil size={10} /></button>
              <button onClick={e => deleteRoom(e, room.id)} className="p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10"><Trash2 size={10} /></button>
            </div>
          </>
        )}
      </div>
      {editingRoomId !== room.id && (
        <div className="flex items-center gap-2 px-3 pb-1.5 ml-4">
          <span className="text-[10px] text-text-muted">{room._count.messages} msgs</span>
          <span className="text-[10px] text-text-muted flex items-center gap-0.5"><Users size={9} /> {room._count.members}</span>
        </div>
      )}
    </div>
  )

  // ── AI-only sections ─────────────────────────────────────────
  const renderAISections = () => {
    const regularConvos = (convos ?? []).filter(c => !c.metadata?.planTarget && !c.metadata?.agentTarget && !c.metadata?.agentChat && !c.metadata?.agentDraft && !c.metadata?.debugChat)

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
                  <div key={c.id} onClick={() => { onSelect(`c_${c.id}`); onMobileSelect?.() }} className={`${rowBase} gap-1.5 ml-2 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
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
              <span className="text-[10px] text-text-muted">{(agentConvos ?? []).length}</span>
            </div>
            {agentChatsOpen && (() => {
              const draftConvos = (agentConvos ?? []).filter(c => c.metadata.agentDraft && !c.metadata.agentTarget && !c.metadata.agentChat)
              const linkedConvos = (agentConvos ?? []).filter(c => !!c.metadata.agentTarget || !!c.metadata.agentChat)
              const convosByAgent = linkedConvos.reduce<Record<string, AgentConvo[]>>((acc, c) => {
                const id = (c.metadata.agentTarget ?? c.metadata.agentChat)!.id
                ;(acc[id] ??= []).push(c)
                return acc
              }, {})
              const agentsWithConvos = (agents ?? []).filter(a => (convosByAgent[a.id]?.length ?? 0) > 0)
              const knownAgentIds = new Set((agents ?? []).map(a => a.id))
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
                    <div key={c.id} onClick={() => { onSelect(`c_${c.id}`); onMobileSelect?.() }} className={`group ${rowBase} gap-1.5 ml-2 ${activeId === `c_${c.id}` ? activeRow : idleRow}`}>
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

  const renderRoomSections = () => {
    // Group rooms by epic hierarchy
    const epicIds = new Set((epics ?? []).map(e => e.id))
    const roomsByEpicId = new Map<string, Room[]>()
    const roomsByFeatureId = new Map<string, Room[]>()
    const unattachedRooms: Room[] = []

    for (const room of rooms ?? []) {
      if (room.epicId && !room.featureId) {
        const list = roomsByEpicId.get(room.epicId) ?? []
        list.push(room)
        roomsByEpicId.set(room.epicId, list)
      } else if (room.featureId) {
        const list = roomsByFeatureId.get(room.featureId) ?? []
        list.push(room)
        roomsByFeatureId.set(room.featureId, list)
      } else {
        unattachedRooms.push(room)
      }
    }

    // Epics that have at least one room (directly or via features)
    const epicsWithRooms = (epics ?? []).filter(epic =>
      (roomsByEpicId.get(epic.id)?.length ?? 0) > 0 ||
      epic.features.some(f => (roomsByFeatureId.get(f.id)?.length ?? 0) > 0)
    )

    // Rooms attached to features whose epic isn't in our epics list (orphaned)
    const allKnownFeatureIds = new Set((epics ?? []).flatMap(e => e.features.map(f => f.id)))
    const featureRoomsWithoutEpic = [...roomsByFeatureId.entries()]
      .filter(([fId]) => !allKnownFeatureIds.has(fId))
      .flatMap(([, rs]) => rs)

    const activeFilter = effectiveRoomFilter

    return (
      <>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-border-subtle flex-shrink-0">
          <span className="text-xs font-semibold text-text-secondary">Chat Rooms</span>
          <button onClick={onCreateNew} className="p-1 rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors" title="New room">
            <Plus size={14} />
          </button>
        </div>

        {/* Type filter chips */}
        <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-border-subtle">
          <button
            onClick={() => setRoomFilter('')}
            className={`px-2 py-0.5 rounded-full text-[10px] transition-colors ${!activeFilter ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary hover:bg-bg-raised'}`}
          >all</button>
          {ROOM_TYPES.map(t => (
            <button
              key={t}
              onClick={() => setRoomFilter(activeFilter === t ? '' : t)}
              className={`px-2 py-0.5 rounded-full text-[10px] transition-colors ${activeFilter === t ? `${TYPE_COLORS[t]} ring-1 ring-current` : 'text-text-muted hover:text-text-primary hover:bg-bg-raised'}`}
            >{t}</button>
          ))}
        </div>

        {rooms.length === 0 ? (
          <div className="p-4 text-center text-text-muted text-xs">No chat rooms yet.</div>
        ) : activeFilter ? (
          /* Flat filtered list */
          <>
            {filteredRooms.length === 0 ? (
              <div className="p-4 text-center text-text-muted text-xs">No {activeFilter} rooms.</div>
            ) : filteredRooms.map(r => renderRoom(r))}
          </>
        ) : (
          <>
            {/* Epic hierarchy */}
            {epicsWithRooms.map(epic => {
              const isOpen = expandedEpics.has(epic.id)
              const epicRooms = roomsByEpicId.get(epic.id) ?? []
              const featureCount = epic.features.filter(f => (roomsByFeatureId.get(f.id)?.length ?? 0) > 0).length
              const totalRooms = epicRooms.length + featureCount

              return (
                <div key={epic.id}>
                  {/* Epic heading */}
                  <div
                    onClick={() => toggleEpic(epic.id)}
                    className={`${rowBase} font-medium text-text-secondary hover:text-text-primary px-3 py-2 border-b border-border-subtle`}
                  >
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Layers size={12} className="flex-shrink-0 text-accent" />
                    <span className="flex-1 truncate text-[11px]">{epic.title}</span>
                    <span className="text-[10px] text-text-muted">{totalRooms}</span>
                  </div>

                  {isOpen && (
                    <div className="border-l border-border-subtle ml-3">
                      {/* Epic-level rooms (planning etc.) */}
                      {epicRooms.map(r => renderRoom(r, true))}

                      {/* Feature rooms */}
                      {epic.features.map(feature => {
                        const fRooms = roomsByFeatureId.get(feature.id) ?? []
                        if (fRooms.length === 0) return null
                        return (
                          <div key={feature.id}>
                            <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] text-text-muted border-b border-border-subtle bg-bg-base/30">
                              <GitBranch size={9} className="flex-shrink-0" />
                              <span className="truncate">{feature.title}</span>
                            </div>
                            {fRooms.map(r => renderRoom(r, true))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Feature rooms whose epic isn't loaded */}
            {featureRoomsWithoutEpic.map(r => renderRoom(r))}

            {/* Unattached rooms */}
            {unattachedRooms.length > 0 && (
              <>
                {(epicsWithRooms.length > 0 || featureRoomsWithoutEpic.length > 0) && (
                  <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wide border-b border-border-subtle bg-bg-base/30">Other</div>
                )}
                {unattachedRooms.map(r => renderRoom(r))}
              </>
            )}
          </>
        )}
      </>
    )
  }


  // ── Main render ───────────────────────────────────────────────
  return (
    <aside className="w-full md:w-56 lg:w-64 h-full flex-shrink-0 flex flex-col border-r border-border-subtle bg-bg-sidebar overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {view === 'ai' ? renderAISections() : renderRoomSections()}
      </div>
    </aside>
  )
}
