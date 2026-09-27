import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/management-tools', () => ({
  MANAGEMENT_TOOL_DEFS: [
    { name: 'gitops_propose', description: 'Propose a GitOps change\nmore detail' },
    { name: 'knowledge_search', description: 'Search the knowledge base' },
    { name: 'orion_escalate_task', description: 'Escalate a task' },
    { name: 'observable_add', description: 'Add an observable' },
  ],
}))
vi.mock('@/lib/agent-runner/abort', () => ({
  isAbortErrorMessage: (m: string) => m.startsWith('[aborted]'),
}))

import { parsePlan, planRequiresApproval } from './plan'
import { buildScopedToolList, managementToolLines } from './tool-scope'
import { isTransientError } from './task/failure'

describe('parsePlan', () => {
  it('returns null until a <plan> block appears', () => {
    expect(parsePlan('thinking about it...')).toBeNull()
  })

  it('extracts fields, step lists and risk', () => {
    const plan = parsePlan(`Here:
<plan>
  <summary>Restart the ingress</summary>
  <risk_level>HIGH</risk_level>
  <steps><step>drain</step><step> restart </step><step></step></steps>
  <verify_steps><step>curl /health</step></verify_steps>
  <rollback_steps><step>rollout undo</step></rollback_steps>
</plan>`)
    expect(plan).toMatchObject({
      summary: 'Restart the ingress',
      riskLevel: 'high',
      steps: ['drain', 'restart'],
      verifySteps: ['curl /health'],
      rollbackSteps: ['rollout undo'],
    })
    expect(planRequiresApproval(plan)).toBe(true)
  })

  it('treats unknown risk as null (not approval-gated here)', () => {
    const plan = parsePlan('<plan><risk_level>spicy</risk_level></plan>')
    expect(plan?.riskLevel).toBeNull()
    expect(planRequiresApproval(plan)).toBe(false)
    expect(planRequiresApproval(null)).toBe(false)
  })
})

describe('buildScopedToolList', () => {
  it('falls back to the full inventory when no task type matches', () => {
    const { lines, scoped } = buildScopedToolList('hello there', false)
    expect(scoped).toBe(false)
    expect(lines.split('\n')).toEqual(managementToolLines())
  })

  it('scopes to the matched groups plus core tools, first description line only', () => {
    const { lines, scoped } = buildScopedToolList('deploy the new image tag', true)
    expect(scoped).toBe(true)
    expect(lines).toContain('- gitops_propose: Propose a GitOps change')
    expect(lines).not.toContain('more detail')
    expect(lines).toContain('- knowledge_search:')
    expect(lines).not.toContain('observable_add')
    expect(lines).toContain('gateway tools available')
  })
})

describe('isTransientError', () => {
  it('retries network/rate-limit failures', () => {
    expect(isTransientError('fetch failed: ECONNRESET')).toBe(true)
    expect(isTransientError('HTTP 429 rate_limit')).toBe(true)
  })

  it('never retries aborts, even when they mention a timeout', () => {
    expect(isTransientError('[aborted] request timeout')).toBe(false)
  })

  it('does not retry logic errors', () => {
    expect(isTransientError('Invalid tool arguments')).toBe(false)
  })
})
