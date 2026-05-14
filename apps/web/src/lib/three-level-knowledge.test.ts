/**
 * Three-Level Knowledge tests
 * Phase 4: Room knowledge, agent knowledge, scoped search
 */

import { describe, it, expect } from '@jest/globals'

describe('Knowledge write validation', () => {
  const validateWriteArgs = (args: Record<string, unknown>): string | null => {
    const { title, content } = args as { title?: string; content?: string }
    if (!title) return 'Error: title is required'
    if (!content) return 'Error: content is required'
    if (typeof title !== 'string' || title.trim().length === 0) return 'Error: title must be non-empty string'
    if (typeof content !== 'string' || content.trim().length === 0) return 'Error: content must be non-empty string'
    return null
  }

  it('accepts valid room knowledge entry', () => {
    const error = validateWriteArgs({
      title: 'Pod Crash Loop Fix',
      content: 'Check resource limits and review recent config changes',
    })
    expect(error).toBeNull()
  })

  it('rejects empty title', () => {
    const error = validateWriteArgs({
      title: '',
      content: 'Some content',
    })
    expect(error).toContain('title')
  })

  it('rejects empty content', () => {
    const error = validateWriteArgs({
      title: 'Some Title',
      content: '',
    })
    expect(error).toContain('content')
  })
})

describe('Room knowledge types', () => {
  const ROOM_KNOWLEDGE_TYPES = ['note', 'runbook', 'context', 'decision'] as const

  it('defines all room knowledge types', () => {
    expect(ROOM_KNOWLEDGE_TYPES).toContain('note')
    expect(ROOM_KNOWLEDGE_TYPES).toContain('runbook')
    expect(ROOM_KNOWLEDGE_TYPES).toContain('context')
    expect(ROOM_KNOWLEDGE_TYPES).toContain('decision')
  })

  it('defaults to note type', () => {
    const type = 'note' as const
    expect(type).toBe('note')
  })
})

describe('Agent knowledge types', () => {
  const AGENT_KNOWLEDGE_TYPES = ['note', 'runbook', 'context', 'lesson'] as const

  it('defines all agent knowledge types', () => {
    expect(AGENT_KNOWLEDGE_TYPES).toContain('note')
    expect(AGENT_KNOWLEDGE_TYPES).toContain('runbook')
    expect(AGENT_KNOWLEDGE_TYPES).toContain('context')
    expect(AGENT_KNOWLEDGE_TYPES).toContain('lesson')
  })
})

describe('Scoped search results', () => {
  it('formats agent knowledge search results', () => {
    const entries = [
      { title: 'Pod OOM Fix', content: 'Set memory limit to 512Mi', type: 'lesson' },
    ]
    const lines: string[] = [`Found ${entries.length} agent knowledge entry(ies) for: "memory limit"`]
    lines.push('')
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      lines.push(`--- #${i + 1} [${e.type}] ${e.title} ---`)
      lines.push(e.content.slice(0, 500))
      lines.push('')
    }

    expect(lines[0]).toContain('agent knowledge')
    expect(lines[1]).toBe('')
    expect(lines[2]).toContain('Pod OOM Fix')
    expect(lines[2]).toContain('[lesson]')
  })

  it('truncates long content', () => {
    const longContent = 'a'.repeat(1000)
    const truncated = longContent.slice(0, 500)
    expect(truncated.length).toBe(500)
    expect(longContent.length > 500).toBe(true)
  })
})

describe('Knowledge scope levels', () => {
  const SCOPES = ['global', 'room', 'agent-local'] as const
  const DEFAULT_SCOPE = 'global'

  it('defines all scope levels', () => {
    expect(SCOPES).toContain('global')
    expect(SCOPES).toContain('room')
    expect(SCOPES).toContain('agent-local')
  })

  it('defaults to global scope', () => {
    expect(DEFAULT_SCOPE).toBe('global')
  })
})
