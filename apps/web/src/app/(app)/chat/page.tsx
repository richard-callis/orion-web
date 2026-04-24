'use client'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChatWindow } from '@/components/chat/ChatWindow'

export const dynamic = 'force-dynamic'

interface Conversation {
  id: string
  title: string | null
  createdAt: string
  _count: { messages: number }
}

function ChatContent() {
  const searchParams = useSearchParams()
  const conversationId = searchParams.get('conversation') as string | null
  const taskId = searchParams.get('task')
  const context = searchParams.get('context')

  const handleConversationCreated = (convo: Conversation) => {
    const url = new URL(window.location.href)
    url.searchParams.set('conversation', convo.id)
    if (taskId) url.searchParams.set('task', taskId)
    if (context) url.searchParams.set('context', context)
    window.history.replaceState(null, '', url.toString())
  }

  return (
    <div className="absolute inset-0 flex overflow-hidden">
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
