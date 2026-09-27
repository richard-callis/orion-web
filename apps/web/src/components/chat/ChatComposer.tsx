'use client'
import { useEffect, useRef, useState } from 'react'
import { Send, Square, Server } from 'lucide-react'
import { IconButton } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import type { ChatEnvironment } from './chat-types'

interface Props {
  /** Cleared whenever this becomes null (new chat). */
  conversationId: string | null
  environments: ChatEnvironment[]
  placeholder: string
  streaming: boolean
  onSend: (prompt: string, targetEnvironmentId: string | undefined) => void
  onStop: () => void
}

/**
 * Chat input with @environment targeting. Owns the draft, so typing doesn't
 * re-render the message list.
 */
export function ChatComposer({ conversationId, environments, placeholder, streaming, onSend, onStop }: Props) {
  const [input, setInput] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null) // null = picker hidden
  const [mentionStart, setMentionStart] = useState(0) // index of '@' in input
  const [mentionEnv, setMentionEnv] = useState<ChatEnvironment | null>(null) // confirmed target environment
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (!conversationId) setInput('') }, [conversationId])

  const mentionMatches = mentionQuery !== null
    ? environments.filter(e => e.name.toLowerCase().includes(mentionQuery.toLowerCase()))
    : []

  const submit = () => {
    const prompt = input.trim()
    if (!prompt || streaming) return
    // Parse @mentions from the prompt — last one wins as target environment
    let targetEnvironmentId: string | undefined
    for (const match of prompt.matchAll(/@([\w-]+)/g)) {
      const found = environments.find(e => e.name.toLowerCase() === match[1].toLowerCase())
      if (found) targetEnvironmentId = found.id
    }
    // Also use the confirmed mentionEnv if set (even if text was edited away)
    if (!targetEnvironmentId && mentionEnv) targetEnvironmentId = mentionEnv.id
    setInput('')
    setMentionQuery(null)
    onSend(prompt, targetEnvironmentId)
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    const cursor = e.target.selectionStart ?? val.length
    // Detect if cursor is inside an @mention sequence
    const atMatch = val.slice(0, cursor).match(/@([\w-]*)$/)
    if (atMatch) {
      setMentionQuery(atMatch[1])
      setMentionStart(cursor - atMatch[0].length)
    } else {
      setMentionQuery(null)
    }
  }

  const selectMention = (env: ChatEnvironment) => {
    // Replace the @<partial> with @EnvName
    const before = input.slice(0, mentionStart)
    const after = input.slice(mentionStart + 1 + (mentionQuery?.length ?? 0))
    setInput(`${before}@${env.name}${after.startsWith(' ') ? '' : ' '}${after}`)
    setMentionEnv(env)
    setMentionQuery(null)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (mentionQuery !== null && mentionMatches.length > 0 && e.key === 'Escape') {
      e.preventDefault()
      setMentionQuery(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (mentionQuery !== null && mentionMatches.length === 1) {
        selectMention(mentionMatches[0])
        return
      }
      submit()
    }
  }

  return (
    <div className="border-t border-border-subtle p-4">
      <div className="relative flex gap-2 items-end">
        {/* @mention environment picker popup */}
        {mentionQuery !== null && mentionMatches.length > 0 && (
          <div role="listbox" aria-label="Target environment" className="absolute bottom-full left-0 mb-2 bg-bg-overlay border border-border-visible rounded-lg shadow-lg z-50 min-w-48 max-w-72 overflow-hidden">
            <div className="px-2 py-1.5 border-b border-border-subtle">
              <span className="text-xs text-text-muted">Target environment</span>
            </div>
            {mentionMatches.map(env => (
              <button
                key={env.id}
                role="option"
                aria-selected={false}
                onMouseDown={e => { e.preventDefault(); selectMention(env) }}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg-raised text-left transition-colors"
              >
                <Server size={13} className="text-text-muted flex-shrink-0" />
                <span className="text-sm text-text-primary truncate">{env.name}</span>
                <span className="ml-auto text-xs text-text-muted flex-shrink-0">{env.type}</span>
              </button>
            ))}
          </div>
        )}
        <Textarea
          ref={textareaRef}
          aria-label="Message"
          value={input}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={2}
          className="flex-1 w-auto rounded-lg border-border-visible placeholder-text-muted leading-normal"
        />
        {streaming ? (
          <IconButton
            label="Stop generation"
            onClick={onStop}
            className="p-2.5 rounded-lg bg-status-error/15 text-status-error hover:text-status-error hover:bg-status-error/30 flex-shrink-0"
          >
            <Square size={18} />
          </IconButton>
        ) : (
          <IconButton
            label="Send message"
            onClick={submit}
            disabled={!input.trim()}
            className="p-2.5 rounded-lg bg-accent text-white hover:text-white hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            <Send size={18} />
          </IconButton>
        )}
      </div>
    </div>
  )
}
