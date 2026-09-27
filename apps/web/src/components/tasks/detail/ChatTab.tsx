'use client'
import { useEffect, useRef, useState } from 'react'
import type { KeyedMutator } from 'swr'
import { MessageSquare, Send, Loader2 } from 'lucide-react'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '../../ui/Toast'
import { IconButton } from '../../ui/Button'
import { Input } from '../../ui/Input'

export interface TaskChatMsg {
  id: string
  senderType: string
  content: string
  sender: { type: string; id: string | null; name: string }
  createdAt: string
}

export interface TaskChatRoom {
  id: string
  name: string
  type: string
  messages: TaskChatMsg[]
}

export interface TaskChatData { rooms?: TaskChatRoom[] }

const SENDER_BG: Record<string, string> = {
  agent: 'bg-accent/15 text-accent border-accent/20',
  user: 'bg-bg-raised text-text-secondary border-border-subtle',
  system: 'bg-bg-raised text-text-muted border-border-subtle italic',
}

interface Props {
  taskId: string
  rooms: TaskChatRoom[]
  loading: boolean
  activeRoom: string | null
  onRoomChange: (id: string) => void
  reload: KeyedMutator<TaskChatData>
}

export function ChatTab({ taskId, rooms, loading, activeRoom, onRoomChange, reload }: Props) {
  const toast = useToast()
  const bottomRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  // Scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [rooms, activeRoom])

  const send = async () => {
    const content = input.trim()
    if (!content || sending || !activeRoom) return
    setSending(true)
    setInput('')
    try {
      await apiFetch(`/api/chatrooms/${activeRoom}/messages`, { method: 'POST', body: { content, taskId } })
      await reload()
    } catch (e) {
      setInput(content)
      toast.error(`Failed to send message: ${errorMessage(e, 'unknown error')}`)
    } finally {
      setSending(false)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-12 text-text-muted text-xs">Loading chat…</div>
  )

  const currentRoom: TaskChatRoom | undefined = rooms.length === 0
    ? { id: '', name: 'Task Chat', type: 'task', messages: [] }
    : activeRoom ? rooms.find(r => r.id === activeRoom) : rooms[0]
  if (!currentRoom) return null
  const messages = currentRoom.messages

  return (
    <div className="flex flex-col h-full">
      {/* Room selector (only shown when multiple rooms exist) */}
      {rooms.length > 1 && (
        <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1" role="tablist" aria-label="Task chat rooms">
          {rooms.map(room => (
            <button
              key={room.id}
              role="tab"
              aria-selected={activeRoom === room.id}
              onClick={() => onRoomChange(room.id)}
              className={`flex-shrink-0 px-2.5 py-1 rounded text-[10px] border transition-colors ${
                activeRoom === room.id
                  ? 'bg-accent/15 border-accent/40 text-accent'
                  : 'bg-bg-raised border-border-subtle text-text-muted hover:text-text-secondary'
              }`}
            >
              {room.name}
            </button>
          ))}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {!messages.length ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-text-muted">
            <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center mb-3">
              <MessageSquare size={22} className="text-accent" />
            </div>
            <p className="text-xs">No messages yet</p>
            <p className="text-[10px] mt-1 opacity-60">Bot conversations for this task appear here.</p>
          </div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className={`rounded-lg border px-3 py-2 text-xs ${SENDER_BG[msg.senderType] ?? SENDER_BG.system}`}>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[9px] font-semibold text-text-secondary">
                  {msg.senderType === 'agent' ? msg.sender.name : msg.sender.name || 'system'}
                </span>
                <span className="text-[8px] text-text-muted flex-shrink-0">
                  {new Date(msg.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <pre className="whitespace-pre-wrap break-words leading-relaxed font-mono text-[11px]">{msg.content}</pre>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border-subtle p-2.5 flex gap-2 flex-shrink-0 mt-2">
        <Input
          aria-label="Message"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          placeholder="Send a message…"
          disabled={sending}
          className="flex-1 px-3 py-1.5 text-xs border-border-visible disabled:opacity-100"
        />
        <IconButton
          label="Send message"
          onClick={() => void send()}
          disabled={!input.trim() || sending}
          className="p-1.5 rounded-lg bg-accent text-white hover:bg-accent/80 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </IconButton>
      </div>
    </div>
  )
}
