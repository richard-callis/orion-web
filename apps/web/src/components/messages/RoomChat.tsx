'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Users, Bot, User as UserIcon,
  Hash, Send, X, Loader2, Plus, LogOut, AtSign,
} from 'lucide-react'

/** Render message content with @mention highlighting */
function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(@[\w-]+)/g)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('@')
          ? <span key={i} className="text-accent font-medium">{part}</span>
          : <span key={i}>{part}</span>
      )}
    </>
  )
}

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
  totalMessages?: number
  members?: RoomMember[]
  messages?: RoomMessage[]
}

interface InviteOption {
  id: string
  name: string
  type: string
  username?: string
}

interface Props {
  roomId: string
  onMobileBack: () => void
  onLeave?: () => void
}

const TYPE_COLORS: Record<string, string> = {
  task: 'bg-blue-500/20 text-blue-400',
  feature: 'bg-purple-500/20 text-purple-400',
  general: 'bg-gray-500/20 text-gray-400',
  ops: 'bg-orange-500/20 text-orange-400',
}

export function RoomChat({ roomId, onMobileBack, onLeave }: Props) {
  const [room, setRoom] = useState<RoomDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteUsers, setInviteUsers] = useState<InviteOption[]>([])
  const [inviteAgents, setInviteAgents] = useState<InviteOption[]>([])
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteSearch, setInviteSearch] = useState('')
  const [inviteTab, setInviteTab] = useState<'agents' | 'users'>('agents')
  const [isInviting, setIsInviting] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [mentionSearch, setMentionSearch] = useState<string | null>(null)
  const [messageLimit, setMessageLimit] = useState(100)
  const [typingAgents, setTypingAgents] = useState<string[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  // Derive all mentionable members from loaded room data
  const mentionableMembers = (room?.members ?? []).map(m => ({
    id: m.agent?.id ?? m.user?.id ?? '',
    name: m.agent?.name ?? m.user?.name ?? m.user?.username ?? '',
    isAgent: !!m.agentId,
  })).filter(m => m.name)

  const mentionOptions = mentionSearch !== null
    ? mentionableMembers.filter(m => m.name.toLowerCase().includes(mentionSearch.toLowerCase()))
    : []

  const handleMessageChange = (value: string) => {
    setMessage(value)
    // Detect active @mention: find the last @ with no space after it
    const lastAt = value.lastIndexOf('@')
    if (lastAt !== -1) {
      const partial = value.slice(lastAt + 1)
      if (!partial.includes(' ') && !partial.includes('\n')) {
        setMentionSearch(partial)
        return
      }
    }
    setMentionSearch(null)
  }

  const insertMention = (name: string) => {
    const lastAt = message.lastIndexOf('@')
    const newMsg = message.slice(0, lastAt) + `@${name} `
    setMessage(newMsg)
    setMentionSearch(null)
    inputRef.current?.focus()
  }

  const loadRoom = useCallback(async (limit?: number) => {
    try {
      const res = await fetch(`/api/chatrooms/${roomId}?messages=${limit ?? messageLimit}`)
      const detail = await res.json()
      setRoom(detail)
    } catch { /* ignore */ }
    setLoading(false)
  }, [roomId, messageLimit])

  const loadMore = useCallback(() => {
    const next = messageLimit + 100
    setMessageLimit(next)
    loadRoom(next)
  }, [messageLimit, loadRoom])

  useEffect(() => { loadRoom() }, [loadRoom])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [room?.messages?.length])

  // Subscribe to real-time messages via SSE and poll typing state
  useEffect(() => {
    let active = true

    // SSE subscription for real-time messages
    const connectSSE = () => {
      if (!active || !roomId) return

      const es = new EventSource(`/api/chatrooms/${roomId}/stream`)

      es.addEventListener('message', (event) => {
        if (!active) return
        try {
          const message = JSON.parse(event.data)

          // Skip the initial "connected" message
          if (message.type === 'connected') {
            console.log('[RoomChat] SSE connected for room', roomId)
            return
          }

          // Update room with new message
          setRoom((prev) => {
            if (!prev) return prev
            return {
              ...prev,
              messages: [...(prev.messages || []), message],
              totalMessages: (prev.totalMessages || 0) + 1,
            }
          })
        } catch (e) {
          console.error('[RoomChat] Error parsing SSE message:', e)
        }
      })

      es.addEventListener('error', () => {
        console.warn('[RoomChat] SSE connection error, falling back to polling')
        es.close()
        if (active) {
          // Reconnect after delay if still active
          setTimeout(connectSSE, 5000)
        }
      })

      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }
      eventSourceRef.current = es
    }

    // Typing state polling (every 2s)
    const pollTyping = async () => {
      if (!active) return
      try {
        const res = await fetch(`/api/chatrooms/${roomId}/typing`)
        if (res.ok) {
          const data = await res.json() as { typing: string[] }
          setTypingAgents(data.typing)
        }
      } catch { /* ignore */ }
    }

    connectSSE()
    const typingInterval = setInterval(pollTyping, 2000)

    return () => {
      active = false
      clearInterval(typingInterval)
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
    }
  }, [roomId])

  const handleSendMessage = async () => {
    if (!message.trim() || !room || sending) return
    setSending(true)
    try {
      const res = await fetch(`/api/chatrooms/${room.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message.trim() }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setMessage('')
      // Messages will arrive via SSE in real-time, no need to poll
      // Just reload room once for metadata/counts
      await loadRoom()
    } catch { /* ignore */ }
    setSending(false)
  }

  const loadInviteOptions = useCallback(async () => {
    setInviteLoading(true)
    try {
      const res = await fetch(`/api/chatrooms/${roomId}/members`)
      if (res.ok) {
        const data = await res.json()
        setInviteUsers(data.users || [])
        setInviteAgents(data.agents || [])
      }
    } catch { /* ignore */ }
    setInviteLoading(false)
  }, [roomId])

  const handleInvite = useCallback(async (option: InviteOption) => {
    if (isInviting) return
    setInviteError(null)
    setIsInviting(option.id)
    try {
      const isAgent = inviteTab === 'agents'
      const body: Record<string, string> = {}
      body[isAgent ? 'agentId' : 'userId'] = option.id
      const res = await fetch(`/api/chatrooms/${roomId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) {
        setInviteError(data.error || `HTTP ${res.status}`)
        setIsInviting(null)
        return
      }
      setShowInvite(false)
      setInviteSearch('')
      setInviteTab('agents')
      await loadRoom()
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : 'Unknown error')
    }
    setIsInviting(null)
  }, [roomId, isInviting, inviteTab, loadRoom])

  const handleLeave = useCallback(async () => {
    try {
      await fetch(`/api/chatrooms/${roomId}/join`, { method: 'DELETE' })
    } catch { /* ignore */ }
    setShowLeaveConfirm(false)
    if (onLeave) onLeave()
    else onMobileBack()
  }, [roomId, onLeave, onMobileBack])

  // Filter invite list by search
  const filteredUsers = inviteUsers.filter(u =>
    !inviteSearch || (u.name || u.username || '').toLowerCase().includes(inviteSearch.toLowerCase())
  )
  const filteredAgents = inviteAgents.filter(a =>
    !inviteSearch || a.name.toLowerCase().includes(inviteSearch.toLowerCase())
  )

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <button onClick={onMobileBack} className="md:hidden p-1 rounded hover:bg-bg-raised"><Hash size={16} className="text-text-muted" /></button>
        <Hash size={14} className="text-text-muted flex-shrink-0" />
        <span className="text-sm font-semibold text-text-primary truncate">{room?.name}</span>
        {room && <span className={`px-1.5 py-0.5 rounded text-[9px] flex-shrink-0 ${TYPE_COLORS[room.type] || TYPE_COLORS.general}`}>{room.type}</span>}
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          {/* Invite button */}
          <button
            onClick={() => { setShowInvite(true); loadInviteOptions() }}
            className="p-1.5 rounded hover:bg-bg-raised text-text-muted hover:text-accent transition-colors"
            title="Add member"
          >
            <Plus size={14} />
          </button>
          {/* Leave room button */}
          <button
            onClick={() => setShowLeaveConfirm(true)}
            className="p-1.5 rounded hover:bg-bg-raised text-text-muted hover:text-status-error transition-colors"
            title="Leave room"
          >
            <LogOut size={14} />
          </button>
        </div>
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
            {room?.totalMessages && room.messages && room.totalMessages > room.messages.length && (
              <div className="text-center py-2">
                <button onClick={loadMore} className="text-xs text-accent hover:text-accent/80 transition-colors">
                  ↑ Load more ({room.totalMessages - room.messages.length} older messages)
                </button>
              </div>
            )}
            {(!room?.messages || room.messages.length === 0) && (
              <div className="text-center text-text-muted text-xs py-8">No messages yet. Start the conversation!</div>
            )}
            {room?.messages?.map(msg => (
              <div key={msg.id} className={`max-w-[80%] ${msg.senderType === 'system' ? 'mx-auto text-center' : msg.sender?.type === 'human' || msg.sender?.type === 'user' ? 'ml-auto' : 'mr-auto'}`}>
                {msg.senderType === 'system' ? (
                  <div className="text-[10px] text-text-muted py-1">{msg.content}</div>
                ) : (
                  <div className={`rounded-lg px-3 py-2 ${msg.sender?.type === 'human' || msg.sender?.type === 'user' ? 'bg-accent/20 text-text-primary' : 'bg-bg-raised border border-border-subtle text-text-primary'}`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      {msg.sender?.type === 'agent' ? <Bot size={11} className="text-accent" /> : <UserIcon size={11} />}
                      <span className="text-[10px] font-medium text-text-secondary">{msg.sender?.name}</span>
                      <span className="text-[9px] text-text-muted">{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="text-xs leading-relaxed whitespace-pre-wrap"><MessageContent content={msg.content} /></p>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Typing indicator */}
      {typingAgents.length > 0 && (
        <div className="px-4 py-1 flex items-center gap-1.5 flex-shrink-0">
          <span className="flex gap-0.5 items-end">
            <span className="w-1 h-1 rounded-full bg-accent animate-bounce0" />
            <span className="w-1 h-1 rounded-full bg-accent animate-bounce150" />
            <span className="w-1 h-1 rounded-full bg-accent animate-bounce300" />
          </span>
          <span className="text-[10px] text-text-muted italic">
            {typingAgents.length === 1
              ? `${typingAgents[0]} is typing…`
              : `${typingAgents.slice(0, -1).join(', ')} and ${typingAgents[typingAgents.length - 1]} are typing…`}
          </span>
        </div>
      )}

      {/* Input */}
      <div className="px-4 py-3 border-t border-border-subtle flex-shrink-0 relative">
        {/* @mention dropdown */}
        {mentionSearch !== null && mentionOptions.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 mb-1 bg-bg-sidebar border border-border-subtle rounded-lg shadow-lg overflow-hidden z-10">
            {mentionOptions.map(m => (
              <button
                key={m.id}
                onMouseDown={e => { e.preventDefault(); insertMention(m.name) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-secondary hover:bg-bg-raised hover:text-text-primary transition-colors"
              >
                {m.isAgent ? <Bot size={11} className="text-accent flex-shrink-0" /> : <UserIcon size={11} className="text-text-muted flex-shrink-0" />}
                <span>@{m.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <div className="flex-1 flex items-center relative">
            <AtSign size={13} className="absolute left-2.5 text-text-muted pointer-events-none" />
            <input
              ref={inputRef}
              value={message}
              onChange={e => handleMessageChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setMentionSearch(null); return }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage() }
              }}
              placeholder="Type a message… use @ to mention"
              className="w-full pl-8 pr-3 py-2 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <button onClick={() => { if (message.trim()) handleSendMessage() }} disabled={!message.trim() || sending} className="px-4 py-2 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 flex-shrink-0"><Send size={14} /><span className="hidden sm:inline">Send</span></button>
        </div>
      </div>

      {/* Invite Modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowInvite(false)}>
          <div className="w-full max-w-md bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-60 md:max-h-96" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
              <span className="text-sm font-semibold text-text-primary">Add Member</span>
              <button onClick={() => setShowInvite(false)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>

            {inviteError && (
              <div className="px-4 py-2 border-b border-status-error/30 bg-status-error/10 flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-status-error flex-1">{inviteError}</span>
                <button onClick={() => setInviteError(null)} className="text-status-error hover:text-status-error/60"><X size={14} /></button>
              </div>
            )}

            {/* Search */}
            <div className="px-3 py-2 border-b border-border-subtle flex-shrink-0">
              <input
                value={inviteSearch}
                onChange={e => setInviteSearch(e.target.value)}
                placeholder="Search..."
                className="w-full px-3 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
              />
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border-subtle flex-shrink-0">
              <button
                onClick={() => setInviteTab('agents')}
                className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${inviteTab === 'agents' ? 'text-accent border-b-2 border-accent' : 'text-text-muted hover:text-text-primary'}`}
              >
                Agents ({inviteAgents.length})
              </button>
              <button
                onClick={() => setInviteTab('users')}
                className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${inviteTab === 'users' ? 'text-accent border-b-2 border-accent' : 'text-text-muted hover:text-text-primary'}`}
              >
                Users ({inviteUsers.length})
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {inviteLoading ? (
                <div className="flex items-center justify-center py-8"><Loader2 size={16} className="animate-spin text-text-muted" /></div>
              ) : (inviteTab === 'agents' ? filteredAgents : filteredUsers).length === 0 ? (
                <div className="text-center text-text-muted text-xs py-8">
                  {inviteSearch ? 'No results' : 'No available options'}
                </div>
              ) : (
                (inviteTab === 'agents' ? filteredAgents : filteredUsers).map(option => (
                  <button
                    key={option.id}
                    onClick={() => handleInvite(option)}
                    disabled={isInviting === option.id}
                    className="w-full flex items-center gap-2 px-4 py-2 text-xs text-left text-text-secondary hover:bg-bg-raised hover:text-text-primary transition-colors disabled:opacity-50"
                  >
                    {inviteTab === 'agents' ? (
                      <Bot size={13} className="text-accent flex-shrink-0" />
                    ) : (
                      <UserIcon size={13} className="text-text-muted flex-shrink-0" />
                    )}
                    <span className="flex-1 truncate">
                      {option.name}{option.username ? ` (${option.username})` : ''}
                    </span>
                    {isInviting === option.id ? (
                      <Loader2 size={12} className="animate-spin text-text-muted" />
                    ) : (
                      <Plus size={12} className="text-text-muted" />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Leave Room Confirmation */}
      {showLeaveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowLeaveConfirm(false)}>
          <div className="w-full max-w-sm bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-4">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Leave Room</h3>
              <p className="text-xs text-text-muted mb-4">You will leave this chat room. You can rejoin later if invited.</p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowLeaveConfirm(false)} className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                  Cancel
                </button>
                <button onClick={handleLeave} className="px-3 py-1.5 text-xs rounded bg-status-error text-white hover:bg-status-error/80 transition-colors">
                  Leave
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
