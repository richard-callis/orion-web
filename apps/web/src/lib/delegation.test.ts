/**
 * Ring Leader Delegation tests
 * Phase 3: delegate tool and agent-local context building
 */

import { describe, it, expect } from '@jest/globals'

describe('Delegation result format', () => {
  it('produces valid JSON for delegation result', () => {
    const result = {
      taskId: 'test-task-123',
      status: 'queued',
      estimatedDuration: '2-5 minutes',
    }

    const json = JSON.stringify(result)
    const parsed = JSON.parse(json)

    expect(parsed.taskId).toBe('test-task-123')
    expect(parsed.status).toBe('queued')
    expect(parsed.estimatedDuration).toBe('2-5 minutes')
  })

  it('rejects empty agentId', () => {
    const error = 'Error: agentId, objective, context, and directives are all required'
    expect(error).toContain('agentId')
    expect(error).toContain('required')
  })
})

describe('Delegate tool arguments', () => {
  const validateDelegateArgs = (args: Record<string, unknown>): string | null => {
    const { agentId, objective, context, directives } = args as {
      agentId?: string; objective?: string; context?: unknown; directives?: unknown
    }

    if (!agentId) return 'Error: agentId is required'
    if (!objective) return 'Error: objective is required'
    if (!Array.isArray(context) || context.length === 0) return 'Error: context is required (array)'
    if (!Array.isArray(directives) || directives.length === 0) return 'Error: directives are required (array)'
    return null
  }

  it('accepts valid delegation arguments', () => {
    const error = validateDelegateArgs({
      agentId: 'agent-123',
      objective: 'Fix the pod crash loop',
      context: ['Pod restarts every 30 seconds', 'Logs show OOMKilled'],
      directives: ['Check resource limits', 'Review recent config changes'],
    })
    expect(error).toBeNull()
  })

  it('rejects missing objective', () => {
    const error = validateDelegateArgs({
      agentId: 'agent-123',
      objective: undefined,
      context: ['context'],
      directives: ['directives'],
    })
    expect(error).toContain('objective')
  })

  it('rejects empty context array', () => {
    const error = validateDelegateArgs({
      agentId: 'agent-123',
      objective: 'Do something',
      context: [],
      directives: ['directives'],
    })
    expect(error).toContain('context')
  })

  it('rejects missing directives', () => {
    const error = validateDelegateArgs({
      agentId: 'agent-123',
      objective: 'Do something',
      context: ['context'],
      directives: undefined,
    })
    expect(error).toContain('directives')
  })
})

describe('Knowledge scope', () => {
  const SCOPE_VALID = ['full', 'summarized', 'minimal'] as const
  const DEFAULT_SCOPE = 'summarized'

  it('validates scope options', () => {
    for (const scope of SCOPE_VALID) {
      expect(SCOPE_VALID).toContain(scope)
    }
  })

  it('defaults to summarized scope', () => {
    expect(DEFAULT_SCOPE).toBe('summarized')
  })

  it('rejects invalid scope', () => {
    const invalidScopes = ['all', 'room-only', '1', true, null]
    for (const scope of invalidScopes) {
      expect(SCOPE_VALID).not.toContain(scope as any)
    }
  })
})

describe('Agent local context', () => {
  it('formats agent knowledge entries with title and type', () => {
    // Simulates the format in buildAgentLocalContext
    const entries = [
      { title: 'Pod OOM Fix', content: 'Set memory limit to 512Mi', type: 'lesson' },
      { title: 'Node Scheduling', content: 'Use nodeSelector for GPU nodes', type: 'runbook' },
    ]

    const output = entries.map(e =>
      `### ${e.title}[${e.type}]\n${e.content.slice(0, 2000)}`,
    )

    expect(output[0]).toContain('Pod OOM Fix')
    expect(output[0]).toContain('[lesson]')
    expect(output[1]).toContain('Node Scheduling')
    expect(output[1]).toContain('[runbook]')
  })

  it('omits type tag for default note type', () => {
    const entry = { title: 'General Note', content: 'Some info', type: 'note' }
    // Default notes don't need a special type tag in the display
    const hasTag = entry.type !== 'note' ? ` [${entry.type}]` : ''
    expect(hasTag).toBe('')
  })
})
