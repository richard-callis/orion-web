'use client'
import { useState, useEffect, useMemo, Suspense } from 'react'
import useSWR from 'swr'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { useAgents } from '@/hooks/useAgents'
import { MessageSquare } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
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

const NO_CONVOS: Conversation[] = []
const NO_ROOMS: Room[] = []
const NO_EPICS: EpicsFeature[] = []

function MessagesContent() {
  const searchParams = useSearchParams()
  const incomingRoomId = searchParams.get('r')

  const [view, setView] = useState<'ai' | 'rooms'>('rooms')
  const [activeId, setActiveId] = useState<string | null>(
    incomingRoomId ? `r_${incomingRoomId}` : null
  )
  const [mobileShowList, setMobileShowList] = useState(!incomingRoomId)
  const [roomFilter, setRoomFilter] = useState('')
  const toast = useToast()

  // Sidebar data via SWR; local edits update the cache directly.
  const { data: convos = NO_CONVOS, mutate: mutateConvos } = useSWR<Conversation[]>('/api/chat/conversations')
  const { data: roomsData, mutate: mutateRooms } = useSWR<{ rooms?: Room[] }>('/api/chatrooms?all=true')
  const { data: epics = NO_EPICS } = useSWR<EpicsFeature[]>('/api/epics', { revalidateOnFocus: false })
  const { agents } = useAgents()
  const rooms = roomsData?.rooms ?? NO_ROOMS
  const setConvos = (fn: (list: Conversation[]) => Conversation[]) => { void mutateConvos(prev => fn(prev ?? []), { revalidate: false }) }
  const setRooms = (fn: (list: Room[]) => Room[]) => { void mutateRooms(prev => ({ ...prev, rooms: fn(prev?.rooms ?? []) }), { revalidate: false }) }

  // When navigated to with ?r=<roomId>, activate that room
  useEffect(() => {
    if (incomingRoomId) {
      setView('rooms')
      setActiveId(`r_${incomingRoomId}`)
      setMobileShowList(false)
    }
  }, [incomingRoomId])

  const handleSelect = (id: string) => {
    setActiveId(id)
    setMobileShowList(false)
  }

  const handleCreateNew = async () => {
    const target = view === 'rooms' ? 'rooms' : 'ai'
    setView(target)
    if (target === 'ai') {
      try {
        const convo = await apiFetch<Conversation>('/api/chat/conversations', { method: 'POST', body: {} })
        setConvos(prev => [convo, ...prev])
        setActiveId(`c_${convo.id}`)
        setMobileShowList(false)
      } catch (e) {
        toast.error(`Failed to start a conversation: ${errorMessage(e)}`)
      }
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

  const handleRoomUpdate = (id: string, patch: { name?: string; type?: string }) => {
    setRooms(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
  }

  const handleNewRoom = async () => {
    try {
      const room = await apiFetch<Room>('/api/chatrooms', { method: 'POST', body: { name: 'New Room', type: 'general' } })
      setRooms(prev => [room, ...prev])
      setActiveId(`r_${room.id}`)
      setMobileShowList(false)
    } catch (e) {
      toast.error(`Failed to create room: ${errorMessage(e)}`)
    }
  }

  const { regularConvos, planningConvos, agentConvos, debugConvos } = useMemo(() => ({
    regularConvos: convos.filter(c => !c.metadata?.planTarget && !c.metadata?.agentTarget && !c.metadata?.agentChat && !c.metadata?.agentDraft && !c.metadata?.debugChat),
    planningConvos: convos.filter(c => !!c.metadata?.planTarget) as PlanningConvo[],
    agentConvos: convos.filter(c => !!c.metadata?.agentTarget || !!c.metadata?.agentChat || !!c.metadata?.agentDraft) as AgentConvo[],
    debugConvos: convos.filter(c => !!c.metadata?.debugChat) as DebugConvo[],
  }), [convos])

  return (
    <div className="absolute inset-0 flex">
      {/* Sidebar - Message List */}
      <div className={`${mobileShowList || !activeId?.startsWith('r_') ? 'flex' : 'hidden'} md:flex flex-col w-full md:w-56 lg:w-64 shrink-0 border-r border-border-subtle bg-bg-sidebar`}>
        {/* View selector */}
        <div className="flex items-center justify-between px-3 py-3 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-accent" />
            <span className="text-sm font-semibold text-text-primary">Messages</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setView('ai')}
              className={`px-2 py-0.5 rounded-sm text-[10px] ${view === 'ai' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'}`}
            >AI</button>
            <button
              onClick={() => setView('rooms')}
              className={`px-2 py-0.5 rounded-sm text-[10px] ${view === 'rooms' ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'}`}
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
          onRoomUpdate={handleRoomUpdate}
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
      <div className={`${!mobileShowList || !activeId?.startsWith('r_') ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden`}>
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

export default function MessagesPage() {
  return (
    <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm">Loading messages…</div>}>
      <MessagesContent />
    </Suspense>
  )
}
