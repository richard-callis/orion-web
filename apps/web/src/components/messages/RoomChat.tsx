'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Users, Bot, User as UserIcon,
  Hash, Send, X, Loader2,
} from 'lucide-react'

interface RoomMember {
  userId: string | null
  agentId: string | null
  role: string
  agent?: { id: string; name: string; type: string } | null
  user?: { id: string; username: string; name: string } | null
}

interface RoomMessage {
  id: string
  senderType: string
  content: string
  attachments: unknown[]
  sender: { type: string; id: string | null; name: string }
  createdAt: string
}

interface RoomDetail {
  id: string
  name: string
  description: string | null
  type: string
  createdBy: string
  createdAt: string
  updatedAt: string
  _count?: { messages: number; members: number }
  members?: RoomMember[]
  messages?: RoomMessage[]
}

interface Props {
  roomId: string
  onMobileBack: () => void
}

const TYPE_COLORS: Record<string, string> = {
  task: 'bg-blue-500/20 text-blue-400',
  feature: 'bg-purple-500/20 text-purple-400',
  general: 'bg-gray-500/20 text-gray-400',
  ops: 'bg-orange-500/20 text-orange-400',
}

export function RoomChat({ roomId, onMobileBack }: Props) {
  const [room, setRoom] = useState<RoomDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const loadRoom = useCallback(async () => {
    try {
      const res = await fetch(`/api/chatrooms/${roomId}?messages=100`)
      const detail = await res.json()
      setRoom(detail)
    } catch { /* ignore */ }
    setLoading(false)
  }, [roomId])

  useEffect(() => { loadRoom() }, [loadRoom])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [room?.messages?.length])

  const handleSendMessage = async () => {
    if (!message.trim() || !room || sending) return
    setSending(true)
    try {
      await fetch(`/api/chatrooms/${room.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message.trim() }),
      })
      setMessage('')
      await loadRoom()
    } catch { /* ignore */ }
    setSending(false)
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <button onClick={onMobileBack} className="md:hidden p-1 rounded hover:bg-bg-raised"><Hash size={16} className="text-text-muted" /></button>
        <Hash size={14} className="text-text-muted flex-shrink-0" />
        <span className="text-sm font-semibold text-text-primary truncate">{room?.name}</span>
        {room && <span className={`px-1.5 py-0.5 rounded text-[9px] flex-shrink-0 ${TYPE_COLORS[room.type] || TYPE_COLORS.general}`}>{room.type}</span>}
        <span className="text-[10px] text-text-muted ml-auto flex items-center gap-1 flex-shrink-0"><Users size={11} /> {room?._count?.members || room?.members?.length || 0}</span>
      </div>

      {/* Members bar */}
      {room?.members && room.members.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border-subtle flex-shrink-0 overflow-x-auto">
          <span className="text-[10px] text-text-muted flex-shrink-0">Members:</span>
          {room.members.map((m, i) => (
            <span key={i} className="flex items-center gap-1 text-[10px] text-text-secondary bg-bg-raised px-2 py-0.5 rounded-full flex-shrink-0">
              {m.agent ? <Bot size={11} className="text-accent" /> : <UserIcon size={11} />}
              {m.agent?.name || m.user?.name || m.user?.username || 'unknown'}
              {m.role === 'lead' && <span className="text-accent">.</span>}
            </span>
          ))}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center h-full"><Loader2 size={20} className="animate-spin text-text-muted" /></div>
        ) : (
          <>
            {(!room?.messages || room.messages.length === 0) && (
              <div className="text-center text-text-muted text-xs py-8">No messages yet. Start the conversation!</div>
            )}
            {room?.messages?.map(msg => (
              <div key={msg.id} className={`max-w-[80%] ${msg.senderType === 'system' ? 'mx-auto text-center' : msg.sender.type === 'human' || msg.sender.type === 'user' ? 'ml-auto' : 'mr-auto'}`}>
                {msg.senderType === 'system' ? (
                  <div className="text-[10px] text-text-muted py-1">{msg.content}</div>
                ) : (
                  <div className={`rounded-lg px-3 py-2 ${msg.sender.type === 'human' || msg.sender.type === 'user' ? 'bg-accent/20 text-text-primary' : 'bg-bg-raised border border-border-subtle text-text-primary'}`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      {msg.sender.type === 'agent' ? <Bot size={11} className="text-accent" /> : <UserIcon size={11} />}
                      <span className="text-[10px] font-medium text-text-secondary">{msg.sender.name}</span>
                      <span className="text-[9px] text-text-muted">{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="text-xs leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-border-subtle flex-shrink-0">
        <div className="flex gap-2">
          <input value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }} placeholder="Type a message..." className="flex-1 px-3 py-2 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent" />
          <button onClick={handleSendMessage} disabled={!message.trim() || sending} className="px-4 py-2 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 flex-shrink-0"><Send size={14} /><span className="hidden sm:inline">Send</span></button>
        </div>
      </div>
    </>
  )
}
