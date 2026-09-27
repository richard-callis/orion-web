import { describe, it, expect } from 'vitest'
import { applyChunk, withLastAssistant } from './useChatStream'
import type { ChatMessage } from './chat-types'
import type { StreamChunk } from '@/lib/claude'

const assistant = (over: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'assistant', content: '', toolCalls: [], streaming: true, ...over })
const chunk = (c: Partial<StreamChunk>) => c as StreamChunk

describe('withLastAssistant', () => {
  it('replaces only the trailing assistant message, immutably', () => {
    const user: ChatMessage = { role: 'user', content: 'hi' }
    const last = assistant({ content: 'a' })
    const prev = [user, last]
    const next = withLastAssistant(prev, m => ({ ...m, content: m.content + 'b' }))
    expect(next).not.toBe(prev)
    expect(next[0]).toBe(user)
    expect(next[1].content).toBe('ab')
    expect(last.content).toBe('a') // original object untouched
  })

  it('is a no-op when the last message is not from the assistant', () => {
    const prev: ChatMessage[] = [{ role: 'user', content: 'x' }]
    expect(withLastAssistant(prev, m => ({ ...m, content: 'changed' }))).toBe(prev)
  })
})

describe('applyChunk', () => {
  it('appends text without mutating the input', () => {
    const last = assistant({ content: 'Hel' })
    const next = applyChunk(last, 'text', chunk({ type: 'text', content: 'lo' }))
    expect(next.content).toBe('Hello')
    expect(last.content).toBe('Hel')
  })

  it('records a tool call, then fills its output', () => {
    const withCall = applyChunk(assistant(), 'tool_call', chunk({ type: 'tool_call', tool: 'kubectl_get', input: '{}' }))
    const withResult = applyChunk(withCall, 'tool_result', chunk({ type: 'tool_result', output: 'pods' }))
    expect(withResult.toolCalls).toEqual([{ tool: 'kubectl_get', input: '{}', output: 'pods' }])
    expect(withCall.toolCalls).toEqual([{ tool: 'kubectl_get', input: '{}' }])
  })

  it('ignores a tool_result with no pending call', () => {
    const last = assistant()
    expect(applyChunk(last, 'tool_result', chunk({ type: 'tool_result', output: 'x' }))).toBe(last)
  })

  it('ends streaming on done', () => {
    expect(applyChunk(assistant(), 'done', chunk({ type: 'done' })).streaming).toBe(false)
  })

  it('maps auth errors to a friendly message', () => {
    const next = applyChunk(assistant({ content: 'partial' }), 'error', chunk({ type: 'error', error: 'authentication_error: bad key' }))
    expect(next.streaming).toBe(false)
    expect(next.content).toMatch(/^partial\n\n⚠ Authentication error/)
  })
})
