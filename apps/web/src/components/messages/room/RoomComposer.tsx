'use client'
import { useRef, useState } from 'react'
import { Bot, User as UserIcon, Send, AtSign } from 'lucide-react'
import { Textarea } from '@/components/ui/Textarea'
import type { RoomMember } from './types'

interface Props {
  members: RoomMember[]
  sending: boolean
  /** Resolves true when the message was sent (the box is then cleared). */
  onSend: (content: string) => Promise<boolean>
}

const EVERYONE = { id: '__everyone__', name: 'everyone', isAgent: false }

/** Message box with @mention autocomplete. Owns its own text so typing never re-renders the message list. */
export function RoomComposer({ members, sending, onSend }: Props) {
  const [message, setMessage] = useState('')
  const [mentionSearch, setMentionSearch] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const mentionable = members.map(m => ({
    id: m.agent?.id ?? m.user?.id ?? '',
    name: m.agent?.name ?? m.user?.name ?? m.user?.username ?? '',
    isAgent: !!m.agentId,
  })).filter(m => m.name)

  const mentionOptions = mentionSearch !== null
    ? [
        ...('everyone'.includes(mentionSearch.toLowerCase()) ? [EVERYONE] : []),
        ...mentionable.filter(m => m.name.toLowerCase().includes(mentionSearch.toLowerCase())),
      ]
    : []

  const handleChange = (value: string) => {
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
    setMessage(message.slice(0, lastAt) + `@${name} `)
    setMentionSearch(null)
    inputRef.current?.focus()
  }

  const send = async () => {
    const content = message.trim()
    if (!content || sending) return
    if (await onSend(content)) setMessage('')
  }

  return (
    <div className="px-4 py-3 border-t border-border-subtle flex-shrink-0 relative">
      {/* @mention dropdown */}
      {mentionSearch !== null && mentionOptions.length > 0 && (
        <div role="listbox" aria-label="Mention" className="absolute bottom-full left-4 right-4 mb-1 bg-bg-sidebar border border-border-subtle rounded-lg shadow-lg overflow-hidden z-10">
          {mentionOptions.map(m => (
            <button
              key={m.id}
              role="option"
              aria-selected={false}
              onMouseDown={e => { e.preventDefault(); insertMention(m.name) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-secondary hover:bg-bg-raised hover:text-text-primary transition-colors"
            >
              {m.id === EVERYONE.id
                ? <AtSign size={11} className="text-yellow-400 flex-shrink-0" />
                : m.isAgent
                ? <Bot size={11} className="text-accent flex-shrink-0" />
                : <UserIcon size={11} className="text-text-muted flex-shrink-0" />}
              <span className={m.id === EVERYONE.id ? 'text-yellow-400 font-semibold' : ''}>@{m.name}</span>
              {m.id === EVERYONE.id && <span className="text-[9px] text-text-muted ml-auto">notify all agents</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <div className="flex-1 flex items-start relative">
          <AtSign size={13} className="absolute left-2.5 top-2.5 text-text-muted pointer-events-none" aria-hidden />
          <Textarea
            ref={inputRef}
            aria-label="Message"
            value={message}
            onChange={e => handleChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setMentionSearch(null); return }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
            }}
            placeholder="Type a message… use @ to mention"
            rows={2}
            className="pl-8 pr-3 text-xs border-border-visible placeholder-text-muted leading-normal"
          />
        </div>
        <button
          onClick={() => void send()}
          disabled={!message.trim() || sending}
          className="px-4 py-2 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 flex-shrink-0"
        >
          <Send size={14} /><span className="hidden sm:inline">Send</span>
        </button>
      </div>
    </div>
  )
}
