'use client'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { ConversationList } from '@/components/chat/ConversationList'

interface Conversation {
  id: string
  title: string | null
  createdAt: string
  metadata?: { planTarget?: { type: string; id: string }; agentTarget?: { id: string; name: string }; agentChat?: { id: string; name: string }; agentDraft?: boolean; debugChat?: boolean } | null
  _count: { messages: number }
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

interface Agent {
  id: string
  name: string
}

function ChatPageInner() {
  const params = useSearchParams()
  const preselect = params.get('conversation') ?? null
  const [activeId, setActiveId] = useState<string | null>(null)
  const [convos, setConvos] = useState<Conversation[]>([])
  const [epics, setEpics] = useState<Epic[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [mobileShowList, setMobileShowList] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/chat/conversations').then(r => r.json()),
      fetch('/api/epics').then(r => r.json()).catch(() => []),
      fetch('/api/agents').then(r => r.json()).catch(() => []),
    ]).then(([data, epicData, agentData]: [Conversation[], Epic[], Agent[]]) => {
      setConvos(data)
      setEpics(epicData)
      setAgents(agentData)
      if (preselect && data.some((c: Conversation) => c.id === preselect)) {
        setActiveId(preselect)
        setMobileShowList(false)
      } else {
        const regular = data.filter(c => !c.metadata?.planTarget && !c.metadata?.agentTarget)
        if (regular.length > 0) setActiveId(regular[0].id)
        else if (data.length > 0) setActiveId(data[0].id)
      }
    }).catch(() => {})
  }, [])

  const handleNewConversation = (convo: Conversation) => {
    setConvos(prev => [convo, ...prev])
    setActiveId(convo.id)
  }

  const handleDelete = (id: string) => {
    setConvos(prev => prev.filter(c => c.id !== id))
    if (activeId === id) setActiveId(null)
  }

  const handleRename = (id: string, title: string) => {
    setConvos(prev => prev.map(c => c.id === id ? { ...c, title } : c))
  }

  const regularConvos  = convos.filter(c => !c.metadata?.planTarget && !c.metadata?.agentTarget && !c.metadata?.agentChat && !c.metadata?.agentDraft && !c.metadata?.debugChat)
  const planningConvos = convos.filter(c => !!c.metadata?.planTarget) as (Conversation & { metadata: { planTarget: { type: string; id: string } } })[]
  const agentConvos    = convos.filter(c => !!c.metadata?.agentTarget || !!c.metadata?.agentChat || !!c.metadata?.agentDraft) as (Conversation & { metadata: { agentTarget?: { id: string; name: string }; agentChat?: { id: string; name: string }; agentDraft?: boolean } })[]
  const debugConvos    = convos.filter(c => !!c.metadata?.debugChat)

  return (
    <div className="absolute inset-0 flex">
      <div className={`${mobileShowList ? 'flex' : 'hidden'} md:flex flex-col w-full md:w-auto`}>
        <ConversationList
          convos={regularConvos}
          planningConvos={planningConvos}
          agentConvos={agentConvos}
          debugConvos={debugConvos}
          epics={epics}
          agents={agents}
          activeId={activeId ?? undefined}
          onSelect={id => setActiveId(id || null)}
          onDelete={handleDelete}
          onRename={handleRename}
          onMobileSelect={() => setMobileShowList(false)}
        />
      </div>
      <div className={`${!mobileShowList ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0 overflow-hidden`}>
        <ChatWindow
          conversationId={activeId}
          onConversationCreated={handleNewConversation}
          onMobileBack={() => setMobileShowList(true)}
        />
      </div>
    </div>
  )
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatPageInner />
    </Suspense>
  )
}
