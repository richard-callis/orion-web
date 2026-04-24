'use client'
import { useState, useEffect, useCallback } from 'react'
import { MessageSquare } from 'lucide-react'
import { MessageList } from '@/components/messages/MessageList'
import { ChatContainer } from '@/components/messages/ChatContainer'

interface Conversation {
  id: string
  title: string | null
  createdAt: string
  metadata?: {
    planTarget?: { type: string; id: string }
    agentTarget?: { id: string; name: string }
    agentChat?: { id: string; name: string }
    agentDraft?: boolean
    debugChat?: boolean
  } | null
  _count: { messages: number }
}

interface PlanningConvo { id: string; title: string | null; metadata: { planTarget: { type: string; id: string } } }
interface AgentConvo { id: string; title: string | null; metadata: { agentTarget?: { id: string; name: string }; agentChat?: { id: string; name: string }; agentDraft?: boolean } }
interface DebugConvo { id: string; title: string | null }

interface EpicsFeature { id: string; title: string; features: { id: string; title: string }[] }
interface Agent { id: string; name: string }

interface Room {
  id: string
  name: string
  type: string
  created_at: string
  _count: { messages: number; members: number }
  task?: { id: string; title: string } | null
}

export default function MessagesPage() {
  const [view, setView] = useState<'ai' | 'rooms'>('ai')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [mobileShowList, setMobileShowList] = useState(true)
  const [convos, setConvos] = useState<Conversation[]>([])
  const [epics, setEpics] = useState<EpicsFeature[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomFilter, setRoomFilter] = useState('')
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [convosRes, epicsRes, agentsRes, roomsRes] = await Promise.all([
        fetch('/api/chat/conversations').then(r => r.json().catch(() => [])),
        fetch('/api/epics').then(r => r.json().catch(() => [])).then((d: any) => Array.isArray(d) ? d : []),
        fetch('/api/agents').then(r => r.json().catch(() => [])).then((d: any) => Array.isArray(d) ? d : []),
        fetch('/api/chatrooms').then(r => r.json().catch(() => ({ rooms: [] }))).then((d: any) => d.rooms || []),
      ])
      setConvos(convosRes)
      setEpics(epicsRes)
      setAgents(agentsRes)
      setRooms(roomsRes)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleSelect = (id: string) => {
    setActiveId(id)
    setMobileShowList(false)
  }

  const handleCreateNew = async () => {
    const target = view === 'rooms' ? 'rooms' : 'ai'
    setView(target)
    if (target === 'ai') {
      try {
        const res = await fetch('/api/chat/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        const convo: Conversation = await res.json()
        setConvos(prev => [convo, ...prev])
        setActiveId(`c_${convo.id}`)
        setMobileShowList(false)
      } catch { /* ignore */ }
    }
  }

  const handleConversationCreated = (convo: Conversation) => {
    setConvos(prev => [convo, ...prev])
    setActiveId(`c_${convo.id}`)
  }

  const handleDelete = (prefixedId: string) => {
    if (prefixedId.startsWith('c_')) {
      const id = prefixedId.slice(2)
      setConvos(prev => prev.filter(c => c.id !== id))
      if (activeId === prefixedId) { setActiveId(null); setMobileShowList(true) }
    } else if (prefixedId.startsWith('r_')) {
      const id = prefixedId.slice(2)
      setRooms(prev => prev.filter(r => r.id !== id))
      if (activeId === prefixedId) { setActiveId(null); setMobileShowList(true) }
    }
  }

  const handleRename = (id: string, title: string) => {
    setConvos(prev => prev.map(c => c.id === id ? { ...c, title: title || null } : c))
  }

  const handleNewRoom = async () => {
    try {
      const res = await fetch('/api/chatrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Room', type: 'general' }),
      })
      const room = await res.json()
      setRooms(prev => [room, ...prev])
      setActiveId(`r_${room.id}`)
      setMobileShowList(false)
    } catch { /* ignore */ }
  }

  const regularConvos = convos.filter(c => !c.metadata?.planTarget && !c.metadata?.agentTarget && !c.metadata?.agentChat && !c.metadata?.agentDraft && !c.metadata?.debugChat)
  const planningConvos = convos.filter(c => !!c.metadata?.planTarget) as PlanningConvo[]
  const agentConvos = convos.filter(c => !!c.metadata?.agentTarget || !!c.metadata?.agentChat || !!c.metadata?.agentDraft) as AgentConvo[]
  const debugConvos = convos.filter(c => !!c.metadata?.debugChat) as DebugConvo[]

  return (
    <div className="absolute inset-0 flex">
      {/* Sidebar - Message List */}
      <div className={`${mobileShowList || !activeId?.startsWith('r_') ? 'flex' : 'hidden'} md:flex flex-col w-full md:w-56 lg:w-64 flex-shrink-0 border-r border-border-subtle bg-bg-sidebar`}>
        {/* View selector */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-accent" />
            <span className="text-sm font-semibold text-text-primary">Messages</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setView('ai')}
              className={`px-2 py-0.5 rounded text-[10px] ${view === 'ai' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'}`}
            >AI</button>
            <button
              onClick={() => setView('rooms')}
              className={`px-2 py-0.5 rounded text-[10px] ${view === 'rooms' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'}`}
            >Rooms</button>
          </div>
        </div>

        {/* MessageList sidebar */}
        <MessageList
          view={view}
          onSelect={handleSelect}
          activeId={activeId ?? undefined}
          onMobileSelect={() => setMobileShowList(false)}
          onCreateNew={view === 'rooms' ? handleNewRoom : handleCreateNew}
          onDelete={handleDelete}
          onRename={handleRename}
          convos={regularConvos}
          planningConvos={planningConvos}
          agentConvos={agentConvos}
          debugConvos={debugConvos}
          epics={epics}
          agents={agents}
          rooms={rooms}
          roomFilter={roomFilter}
          onRoomFilterChange={setRoomFilter}
        />
      </div>

      {/* Main - Chat / Room View */}
      <div className={`${!mobileShowList || !activeId?.startsWith('r_') ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0 overflow-hidden`}>
        <ChatContainer
          activeId={activeId}
          onMobileBack={() => setMobileShowList(true)}
          onConversationCreated={handleConversationCreated}
          onDelete={handleDelete}
          view={view}
        />
      </div>
    </div>
  )
}
