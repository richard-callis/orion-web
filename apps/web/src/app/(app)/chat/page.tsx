'use client'
import { Suspense, useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { ConversationList } from '@/components/chat/ConversationList'

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

interface AgentConvo {
  id: string
  title: string | null
  metadata: { agentTarget?: { id: string; name: string }; agentChat?: { id: string; name: string }; agentDraft?: boolean }
}

interface DebugConvo {
  id: string
  title: string | null
}

interface Epic {
  id: string
  title: string
  features: { id: string; title: string }[]
}

interface Agent {
  id: string
  name: string
}

function ChatContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const conversationId = searchParams.get('conversation') as string | null
  const taskId = searchParams.get('task')
  const context = searchParams.get('context')

  const [convos, setConvos]               = useState<Conversation[]>([])
  const [planningConvos, setPlanningConvos] = useState<PlanningConvo[]>([])
  const [agentConvos, setAgentConvos]     = useState<AgentConvo[]>([])
  const [debugConvos, setDebugConvos]     = useState<DebugConvo[]>([])
  const [epics, setEpics]                 = useState<Epic[]>([])
  const [agents, setAgents]               = useState<Agent[]>([])

  const loadConvos = useCallback(async () => {
    try {
      const data: Array<{ id: string; title: string | null; createdAt: string; metadata?: Record<string, unknown>; _count: { messages: number } }>
        = await fetch('/api/chat/conversations', { cache: 'no-store' }).then(r => r.json())

      const plain: Conversation[]     = []
      const planning: PlanningConvo[] = []
      const agent: AgentConvo[]       = []
      const debug: DebugConvo[]       = []

      for (const c of data) {
        const meta = c.metadata as Record<string, unknown> | undefined
        if (meta?.planTarget)                          planning.push(c as unknown as PlanningConvo)
        else if (meta?.agentTarget || meta?.agentChat || meta?.agentDraft) agent.push(c as unknown as AgentConvo)
        else if (meta?.debugChat)                      debug.push(c as DebugConvo)
        else                                           plain.push(c)
      }

      setConvos(plain)
      setPlanningConvos(planning)
      setAgentConvos(agent)
      setDebugConvos(debug)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadConvos()
    Promise.all([
      fetch('/api/epics').then(r => r.json()).catch(() => []),
      fetch('/api/agents').then(r => r.json()).catch(() => []),
    ]).then(([e, a]) => {
      setEpics(e)
      setAgents(a)
    })
  }, [loadConvos])

  const handleSelect = (id: string) => {
    const url = new URL(window.location.href)
    if (id) {
      url.searchParams.set('conversation', id)
    } else {
      url.searchParams.delete('conversation')
    }
    url.searchParams.delete('task')
    url.searchParams.delete('context')
    router.push(url.pathname + url.search)
  }

  const handleDelete = (id: string) => {
    setConvos(p => p.filter(c => c.id !== id))
    setPlanningConvos(p => p.filter(c => c.id !== id))
    setAgentConvos(p => p.filter(c => c.id !== id))
    setDebugConvos(p => p.filter(c => c.id !== id))
    if (conversationId === id) handleSelect('')
  }

  const handleRename = (id: string, title: string) => {
    const patch = (arr: Conversation[]) => arr.map(c => c.id === id ? { ...c, title } : c)
    setConvos(patch)
    setPlanningConvos(p => p.map(c => c.id === id ? { ...c, title } : c))
    setAgentConvos(p => p.map(c => c.id === id ? { ...c, title } : c))
    setDebugConvos(p => p.map(c => c.id === id ? { ...c, title } : c))
  }

  const handleConversationCreated = (convo: Conversation) => {
    const url = new URL(window.location.href)
    url.searchParams.set('conversation', convo.id)
    if (taskId) url.searchParams.set('task', taskId)
    if (context) url.searchParams.set('context', context)
    window.history.replaceState(null, '', url.toString())
    setConvos(p => [convo, ...p])
  }

  return (
    <div className="absolute inset-0 flex overflow-hidden">
      <ConversationList
        convos={convos}
        planningConvos={planningConvos}
        agentConvos={agentConvos}
        debugConvos={debugConvos}
        epics={epics}
        agents={agents}
        onSelect={handleSelect}
        activeId={conversationId ?? undefined}
        onDelete={handleDelete}
        onRename={handleRename}
      />
      <ChatWindow
        conversationId={conversationId}
        onConversationCreated={handleConversationCreated}
      />
    </div>
  )
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm">Loading chat…</div>}>
      <ChatContent />
    </Suspense>
  )
}
