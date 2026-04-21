'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  MessageSquare, Plus, Send, X, Users, Bot, User as UserIcon,
  Hash, ArrowLeft, ChevronDown, Filter,
} from 'lucide-react'

interface RoomMember {
  agentId: string | null
  userId: string | null
  role: string
  joined_at: string
  agent?: { id: string; name: string; type: string } | null
  user?: { id: string; username: string; name: string } | null
}

interface Room {
  id: string
  name: string
  description: string | null
  type: string
  created_by: string
  created_at: string
  updated_at: string
  _count: { messages: number; members: number }
  task?: { id: string; title: string } | null
  members?: RoomMember[]
}

interface ChatMessage {
  id: string
  sender_type: string
  content: string
  attachments: unknown[]
  sender: { type: string; id: string | null; name: string }
  created_at: string
}

interface RoomDetail extends Room {
  messages: ChatMessage[]
}

const TYPE_COLORS: Record<string, string> = {
  task: 'bg-blue-500/20 text-blue-400',
  feature: 'bg-purple-500/20 text-purple-400',
  general: 'bg-gray-500/20 text-gray-400',
  ops: 'bg-orange-500/20 text-orange-400',
}

export default function ChatRoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [activeRoom, setActiveRoom] = useState<RoomDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showNewRoom, setShowNewRoom] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newType, setNewType] = useState('task')
  const [filterType, setFilterType] = useState('')
  const [mobileShowList, setMobileShowList] = useState(true)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [typing, setTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const loadRooms = useCallback(async () => {
    try {
      const res = await fetch(`/api/chatrooms${filterType ? `?type=${filterType}` : ''}`)
      const data = await res.json()
      setRooms(data.rooms || [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [filterType])

  useEffect(() => { loadRooms() }, [loadRooms])

  const selectRoom = async (room: Room) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/chatrooms/${room.id}?messages=100`)
      const detail = await res.json()
      setActiveRoom(detail)
      setMobileShowList(false)
    } catch { /* ignore */ }
    setLoading(false)
  }

  const handleCreateRoom = async () => {
    if (!newName.trim()) return
    try {
      const res = await fetch('/api/chatrooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          description: newDesc.trim() || undefined,
          type: newType,
        }),
      })
      const room = await res.json()
      setRooms(prev => [room, ...prev])
      setShowNewRoom(false)
      setNewName('')
      setNewDesc('')
      selectRoom(room)
    } catch { /* ignore */ }
  }

  const handleSendMessage = async () => {
    if (!message.trim() || !activeRoom || sending) return
    setSending(true)
    try {
      await fetch(`/api/chatrooms/${activeRoom.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message.trim() }),
      })
      setMessage('')
      // Refresh messages
      const res = await fetch(`/api/chatrooms/${activeRoom.id}?messages=100`)
      const detail = await res.json()
      setActiveRoom(detail)
    } catch { /* ignore */ }
    setSending(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  const handleDeleteRoom = async (roomId: string) => {
    if (!confirm('Delete this room and all its messages?')) return
    await fetch(`/api/chatrooms/${roomId}`, { method: 'DELETE' })
    setRooms(prev => prev.filter(r => r.id !== roomId))
    setActiveRoom(null)
    setMobileShowList(true)
  }

  const handleJoinRoom = async (roomId: string) => {
    await fetch(`/api/chatrooms/${roomId}/join`, { method: 'POST' })
    selectRoom(rooms.find(r => r.id === roomId)!)
  }

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeRoom?.messages?.length])

  const filteredRooms = filterType ? rooms.filter(r => r.type === filterType) : rooms

  return (
    <div className="absolute inset-0 flex">
      {/* Sidebar — Room List */}
      <div className={`${mobileShowList || !activeRoom ? 'flex' : 'hidden'} md:flex flex-col w-full md:w-80 flex-shrink-0 border-r border-border-subtle bg-bg-card`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-accent" />
            <span className="text-sm font-semibold text-text-primary">Chat Rooms</span>
          </div>
          <button
            onClick={() => setShowNewRoom(true)}
            className="p-1.5 rounded hover:bg-bg-raised text-text-muted hover:text-text-primary transition-colors"
            title="New room"
          >
            <Plus size={16} />
          </button>
        </div>

        {/* Type Filter */}
        <div className="px-3 py-2 border-b border-border-subtle">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Filter size={12} className="text-text-muted" />
            <button
              onClick={() => setFilterType('')}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                !filterType ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              All
            </button>
            {['task', 'feature', 'general', 'ops'].map(t => (
              <button
                key={t}
                onClick={() => setFilterType(filterType === t ? '' : t)}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors capitalize ${
                  filterType === t ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Room List */}
        <div className="flex-1 overflow-y-auto">
          {loading && !rooms.length ? (
            <div className="p-4 text-center text-text-muted text-xs">Loading rooms...</div>
          ) : filteredRooms.length === 0 ? (
            <div className="p-4 text-center text-text-muted text-xs">
              No chat rooms yet.
            </div>
          ) : (
            filteredRooms.map(room => (
              <button
                key={room.id}
                onClick={() => selectRoom(room)}
                className={`w-full text-left px-4 py-3 border-b border-border-subtle transition-colors ${
                  activeRoom?.id === room.id
                    ? 'bg-accent/10 border-l-2 border-l-accent'
                    : 'hover:bg-bg-raised'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Hash size={12} className="text-text-muted" />
                  <span className="text-xs font-medium text-text-primary truncate">{room.name}</span>
                  <span className={`ml-auto px-1.5 py-0.5 rounded text-[9px] ${TYPE_COLORS[room.type] || TYPE_COLORS.general}`}>
                    {room.type}
                  </span>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <span className="text-[10px] text-text-muted">
                    {room._count.messages} messages
                  </span>
                  <span className="text-[10px] text-text-muted flex items-center gap-0.5">
                    <Users size={10} /> {room._count.members}
                  </span>
                </div>
                {room.task && (
                  <div className="ml-4 text-[10px] text-accent mt-0.5 truncate">
                    linked: {room.task.title}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Main — Room View */}
      <div className={`${!mobileShowList || !activeRoom ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0 overflow-hidden`}>
        {activeRoom ? (
          <>
            {/* Room Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
              <button
                onClick={() => setMobileShowList(true)}
                className="md:hidden p-1 rounded hover:bg-bg-raised"
              >
                <ArrowLeft size={16} className="text-text-muted" />
              </button>
              <Hash size={14} className="text-text-muted" />
              <span className="text-sm font-semibold text-text-primary">{activeRoom.name}</span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] ${TYPE_COLORS[activeRoom.type] || TYPE_COLORS.general}`}>
                {activeRoom.type}
              </span>
              <span className="text-[10px] text-text-muted ml-auto flex items-center gap-1">
                <Users size={11} /> {activeRoom._count?.members || activeRoom.members?.length || 0}
              </span>
              <button
                onClick={() => handleDeleteRoom(activeRoom.id)}
                className="p-1 rounded hover:bg-red-500/10 text-text-muted hover:text-red-400 transition-colors"
                title="Delete room"
              >
                <X size={14} />
              </button>
            </div>

            {/* Members */}
            <div className="px-4 py-1.5 border-b border-border-subtle flex items-center gap-2 flex-shrink-0 overflow-x-auto">
              <span className="text-[10px] text-text-muted flex-shrink-0">Members:</span>
              {activeRoom.members?.map((m, i) => (
                <span key={i} className="flex items-center gap-1 text-[10px] text-text-secondary bg-bg-raised px-2 py-0.5 rounded-full flex-shrink-0">
                  {m.agent ? <Bot size={10} className="text-accent" /> : <UserIcon size={10} />}
                  {m.agent?.name || m.user?.name || m.user?.username || 'unknown'}
                  {m.role === 'lead' && <span className="text-accent">.</span>}
                </span>
              ))}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {activeRoom.messages?.length === 0 && (
                <div className="text-center text-text-muted text-xs py-8">
                  No messages yet. Start the conversation!
                </div>
              )}
              {activeRoom.messages?.map(msg => (
                <div
                  key={msg.id}
                  className={`max-w-[80%] ${
                    msg.sender_type === 'system'
                      ? 'mx-auto text-center'
                      : msg.sender.type === 'human' || msg.sender.type === 'user'
                      ? 'ml-auto'
                      : 'mr-auto'
                  }`}
                >
                  {msg.sender_type === 'system' ? (
                    <div className="text-[10px] text-text-muted py-1">
                      {msg.content}
                    </div>
                  ) : (
                    <div className={`rounded-lg px-3 py-2 ${
                      msg.sender.type === 'human' || msg.sender.type === 'user'
                        ? 'bg-accent/20 text-text-primary'
                        : 'bg-bg-raised border border-border-subtle text-text-primary'
                    }`}>
                      <div className="flex items-center gap-1.5 mb-1">
                        {msg.sender.type === 'agent' ? (
                          <Bot size={11} className="text-accent" />
                        ) : (
                          <UserIcon size={11} className="text-text-muted" />
                        )}
                        <span className="text-[10px] font-medium text-text-secondary">
                          {msg.sender.name}
                        </span>
                        <span className="text-[9px] text-text-muted">
                          {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Message Input */}
            <div className="px-4 py-3 border-t border-border-subtle flex-shrink-0">
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message..."
                  className="flex-1 px-3 py-2 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!message.trim() || sending}
                  className="px-4 py-2 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 flex-shrink-0"
                >
                  <Send size={14} />
                  <span className="hidden sm:inline">Send</span>
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare size={40} className="mx-auto text-text-muted mb-3 opacity-50" />
              <p className="text-sm text-text-muted">Select a room or create a new one</p>
            </div>
          </div>
        )}
      </div>

      {/* New Room Modal */}
      {showNewRoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-bg-card border border-border-subtle rounded-lg shadow-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-text-primary">New Chat Room</h3>
              <button onClick={() => setShowNewRoom(false)} className="text-text-muted hover:text-text-primary">
                <X size={16} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-medium text-text-muted mb-1">Room Name</label>
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="fix-db-backup-pipeline"
                  className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-text-muted mb-1">Description</label>
                <input
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  placeholder="What is this room for?"
                  className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-text-muted mb-1">Type</label>
                <select
                  value={newType}
                  onChange={e => setNewType(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
                >
                  <option value="task">Task</option>
                  <option value="feature">Feature</option>
                  <option value="general">General</option>
                  <option value="ops">Ops</option>
                </select>
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowNewRoom(false)}
                  className="px-3 py-1.5 text-xs rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateRoom}
                  disabled={!newName.trim()}
                  className="px-3 py-1.5 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
                >
                  Create Room
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
