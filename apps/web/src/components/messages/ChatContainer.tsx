'use client'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { RoomChat } from '@/components/messages/RoomChat'

interface Conversation {
  id: string
  title: string | null
  createdAt: string
  _count: { messages: number }
}

interface Props {
  activeId: string | null
  onMobileBack: () => void
  onConversationCreated: (convo: Conversation) => void
  view: 'ai' | 'rooms' | 'all'
}

export function ChatContainer({ activeId, onMobileBack, onConversationCreated, view }: Props) {
  if (!activeId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-card">
        <div className="text-center">
          <p className="text-sm text-text-muted">
            {view === 'rooms' ? 'Select a room or create a new one' : 'Select a conversation or start a new one'}
          </p>
        </div>
      </div>
    )
  }

  if (activeId.startsWith('r_')) {
    const roomId = activeId.slice(2)
    return <RoomChat roomId={roomId} onMobileBack={onMobileBack} />
  }

  const conversationId = activeId.startsWith('c_') ? activeId.slice(2) : activeId
  return (
    <ChatWindow
      conversationId={conversationId}
      onConversationCreated={onConversationCreated}
      onMobileBack={onMobileBack}
    />
  )
}
