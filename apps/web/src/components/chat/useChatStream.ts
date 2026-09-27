'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StreamChunk } from '@/lib/claude'
import { readSSE } from '@/lib/api'
import type { ChatMessage } from './chat-types'

/** Abort reason used when the user switches conversation mid-stream. */
export const CONVERSATION_CHANGED = 'conversation-changed'

/** Return a new array with the trailing assistant message replaced by `update(msg)`. */
export function withLastAssistant(prev: ChatMessage[], update: (msg: ChatMessage) => ChatMessage): ChatMessage[] {
  const last = prev[prev.length - 1]
  if (!last || last.role !== 'assistant') return prev
  return [...prev.slice(0, -1), update(last)]
}

function friendlyError(raw: string): string {
  if (raw.includes('authentication_error') || raw.includes('Invalid API key') || raw.includes('401'))
    return 'Authentication error — credentials need to be refreshed. Please contact your admin.'
  if (raw.includes('exited with code'))
    return raw.replace(/^.*?(Invalid .+?)\s*·.*$/, '$1').trim() || 'Claude process failed — please try again.'
  return raw
}

/** Apply one stream event to the trailing assistant message (immutably). */
export function applyChunk(last: ChatMessage, event: StreamChunk['type'], data: StreamChunk): ChatMessage {
  switch (event) {
    case 'text':
      return data.content ? { ...last, content: last.content + data.content } : last
    case 'tool_call':
      return { ...last, toolCalls: [...(last.toolCalls ?? []), { tool: data.tool!, input: data.input! }] }
    case 'tool_result': {
      const calls = last.toolCalls ?? []
      if (calls.length === 0) return last
      const lastCall = calls[calls.length - 1]
      return { ...last, toolCalls: [...calls.slice(0, -1), { ...lastCall, output: data.output }] }
    }
    case 'done':
      return { ...last, streaming: false }
    case 'error':
      return { ...last, streaming: false, content: last.content + `\n\n⚠ ${friendlyError(data.error ?? '')}` }
    default:
      return last
  }
}

export interface SendOptions {
  prompt: string
  /** Resolves the conversation to stream into (may create one). */
  conversationId: () => Promise<string>
  /** Extra fields for the stream request body. */
  body?: Record<string, unknown>
}

/**
 * Message list + streaming for one chat view.
 *
 * - Updates are immutable (no in-place mutation of message objects).
 * - `abandon()` aborts the in-flight stream with CONVERSATION_CHANGED so a
 *   stream started in one conversation never writes into another; the
 *   aborted stream then leaves the view's state alone.
 * - `stop()` is the user's Stop button; the partial answer is kept.
 * - Any in-flight stream is aborted on unmount.
 */
export function useChatStream() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const streamingRef = useRef(false)
  streamingRef.current = streaming

  useEffect(() => () => { abortRef.current?.abort() }, [])

  const abandon = useCallback(() => {
    if (!abortRef.current) return
    abortRef.current.abort(CONVERSATION_CHANGED)
    abortRef.current = null
    setStreaming(false)
  }, [])

  const stop = useCallback(() => { abortRef.current?.abort() }, [])

  const send = useCallback(async ({ prompt, conversationId, body }: SendOptions) => {
    if (!prompt || streamingRef.current) return
    setStreaming(true)
    streamingRef.current = true

    const abort = new AbortController()
    abortRef.current = abort
    setMessages(prev => [
      ...prev,
      { role: 'user', content: prompt },
      { role: 'assistant', content: '', toolCalls: [], streaming: true },
    ])

    try {
      const convId = await conversationId()
      const resp = await fetch(`/api/chat/conversations/${convId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...body }),
        signal: abort.signal,
      })
      if (!resp.ok) throw new Error(`Chat request failed: ${resp.status}`)
      if (!resp.body) throw new Error('No response body')

      for await (const evt of readSSE(resp.body, abort.signal)) {
        if (abort.signal.aborted) break
        let data: StreamChunk
        try { data = JSON.parse(evt.data) } catch { continue }
        const event = evt.event as StreamChunk['type']
        setMessages(prev => withLastAssistant(prev, last => applyChunk(last, event, data)))
      }
    } catch (err) {
      // Ignore aborts — the user pressed Stop or switched conversation.
      if (!abort.signal.aborted && !(err instanceof Error && err.name === 'AbortError')) {
        setMessages(prev => withLastAssistant(prev, last => ({
          ...last,
          streaming: false,
          content: last.content + `\n\n⚠ Error: ${err instanceof Error ? err.message : String(err)}`,
        })))
      }
    } finally {
      // If the conversation changed, this stream no longer owns the view.
      if (abort.signal.reason !== CONVERSATION_CHANGED) {
        if (abortRef.current === abort) abortRef.current = null
        setStreaming(false)
        streamingRef.current = false
        setMessages(prev => withLastAssistant(prev, last => (last.streaming ? { ...last, streaming: false } : last)))
      }
    }
  }, [])

  return { messages, setMessages, streaming, send, stop, abandon }
}
