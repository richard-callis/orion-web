'use client'
import { Suspense, useMemo } from 'react'
import useSWR from 'swr'
import { useAgents } from '@/hooks/useAgents'
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

type ConvoRow = Conversation & { metadata?: Record<string, unknown> }

const NO_ROWS: ConvoRow[] = []
const NO_EPICS: Epic[] = []

/** Split conversations into the sidebar sections by their metadata. */
function groupConversations(rows: ConvoRow[]) {
  const convos: Conversation[] = []
  const planningConvos: PlanningConvo[] = []
  const agentConvos: AgentConvo[] = []
  const debugConvos: DebugConvo[] = []
  for (const c of rows) {
    const meta = c.metadata
    if (meta?.planTarget)                                               planningConvos.push(c as unknown as PlanningConvo)
    else if (meta?.agentTarget || meta?.agentChat || meta?.agentDraft)  agentConvos.push(c as unknown as AgentConvo)
    else if (meta?.debugChat)                                           debugConvos.push(c)
    else                                                                convos.push(c)
  }
  return { convos, planningConvos, agentConvos, debugConvos }
}

function ChatContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const conversationId = searchParams.get('conversation') as string | null
  const taskId = searchParams.get('task')
  const context = searchParams.get('context')

  // One conversation list, grouped for the sidebar. SWR keeps it fresh and
  // local edits (delete / rename / create) update the cache directly.
  const { data: rows = NO_ROWS, mutate } = useSWR<ConvoRow[]>('/api/chat/conversations')
  const { convos, planningConvos, agentConvos, debugConvos } = useMemo(() => groupConversations(rows), [rows])
  const { data: epics = NO_EPICS } = useSWR<Epic[]>('/api/epics', { revalidateOnFocus: false })
  const { agents } = useAgents()
  const updateRows = (fn: (rows: ConvoRow[]) => ConvoRow[]) => { void mutate(prev => fn(prev ?? []), { revalidate: false }) }

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
    updateRows(list => list.filter(c => c.id !== id))
    if (conversationId === id) handleSelect('')
  }

  const handleRename = (id: string, title: string) => {
    updateRows(list => list.map(c => c.id === id ? { ...c, title } : c))
  }

  const handleConversationCreated = (convo: Conversation) => {
    const url = new URL(window.location.href)
    url.searchParams.set('conversation', convo.id)
    if (taskId) url.searchParams.set('task', taskId)
    if (context) url.searchParams.set('context', context)
    window.history.replaceState(null, '', url.toString())
    updateRows(list => [convo, ...list])
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
