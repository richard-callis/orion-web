'use client'
import { useEffect, useRef, useState } from 'react'
import { Bot, User, Bell, Terminal, Pause, Play } from 'lucide-react'

interface AgentMsg {
  id: string
  content: string
  messageType: string
  channel: string
  createdAt: string
  agent?: { name: string; type: string } | null
}

const typeIcon = (type: string) => {
  if (type === 'alert') return <Bell size={12} className="text-status-warning" />
  if (type === 'tool_call') return <Terminal size={12} className="text-status-info" />
  if (type === 'action') return <Bot size={12} className="text-accent" />
  return <User size={12} className="text-text-muted" />
}

export function AgentFeed({ initialMessages, initialPaused = false }: { initialMessages: AgentMsg[]; initialPaused?: boolean }) {
  const [messages, setMessages] = useState(initialMessages)
  const [paused, setPaused] = useState(initialPaused)
  const [toggling, setToggling] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Poll for new messages every 10s
  useEffect(() => {
    const poll = () =>
      fetch('/api/agents/messages?limit=50').then(r => r.json()).then(setMessages).catch(() => {})
    const t = setInterval(poll, 10_000)
    return () => clearInterval(t)
  }, [])

  const togglePause = async () => {
    setToggling(true)
    try {
      const res = await fetch('/api/admin/watchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !paused }),
      })
      if (res.ok) {
        const data = await res.json()
        setPaused(data.paused)
      }
    } finally {
      setToggling(false)
    }
  }

  return (
    <aside className="flex-1 min-h-0 flex flex-col border-l border-border-subtle bg-bg-sidebar overflow-hidden">
      <div className="flex items-center px-4 py-3 border-b border-border-subtle flex-shrink-0 gap-2">
        <span className="text-xs font-semibold text-text-secondary flex-1">Agent Feed</span>
        {paused && (
          <span className="text-[10px] font-medium text-status-warning bg-status-warning/10 px-1.5 py-0.5 rounded">
            Watchers paused
          </span>
        )}
        <button
          onClick={togglePause}
          disabled={toggling}
          title={paused ? 'Resume watchers' : 'Pause watchers'}
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-default transition-colors disabled:opacity-50"
        >
          {paused ? <Play size={10} /> : <Pause size={10} />}
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {[...messages].reverse().map(msg => (
          <div key={msg.id} className="rounded-lg bg-bg-card border border-border-subtle p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              {typeIcon(msg.messageType)}
              <span className="text-[10px] font-semibold text-text-secondary">
                {msg.agent?.name ?? 'system'}
              </span>
              <span className="text-[10px] text-text-muted ml-auto">
                {new Date(msg.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-xs text-text-primary leading-relaxed">{msg.content}</p>
          </div>
        ))}
        {!messages.length && (
          <p className="text-xs text-text-muted p-2">No messages yet</p>
        )}
        <div ref={bottomRef} />
      </div>
    </aside>
  )
}
