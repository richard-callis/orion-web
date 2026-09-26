/**
 * approve_execution / deny_execution are human-only (SOC2 H1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { findExecutionForReview, assertCanReview } = vi.hoisted(() => ({
  findExecutionForReview: vi.fn(),
  assertCanReview: vi.fn(),
}))

vi.mock('@/lib/execution-review', () => {
  class ExecutionReviewError extends Error {
    constructor(message: string, public status: number) { super(message) }
  }
  return { findExecutionForReview, assertCanReview, ExecutionReviewError }
})

import { executeRegisteredTool, type ToolExecutionContext } from './tool-registry'
import { ExecutionReviewError } from '@/lib/execution-review'

const userFindUnique = vi.fn()
const prismaDouble = { user: { findUnique: userFindUnique } } as unknown as ToolExecutionContext['prisma']
const args = { executionId: 'uuid-1', reason: 'reviewed' }
const fetchMock = vi.fn()

beforeEach(() => {
  process.env.ORION_EXECUTOR_TOKEN = 'exec-token'
  process.env.ORION_EXECUTOR_URL = 'http://executor'
  findExecutionForReview.mockReset().mockResolvedValue({ id: 'row-1', executionId: 'uuid-1', actorId: 'agent-1' })
  assertCanReview.mockReset()
  userFindUnique.mockReset().mockResolvedValue({ id: 'admin-1', role: 'admin', active: true })
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.ORION_EXECUTOR_TOKEN
  delete process.env.ORION_EXECUTOR_URL
})

describe.each(['approve_execution', 'deny_execution'])('%s', (tool) => {
  it('refuses calls from an agent (MCP / room agent path)', async () => {
    const out = await executeRegisteredTool(tool, args, { prisma: prismaDouble, agentId: 'agent-1' })
    expect(out).toMatch(/human-only/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses calls from a task run, even with a user attached', async () => {
    const out = await executeRegisteredTool(tool, args, { prisma: prismaDouble, taskId: 't-1', userId: 'admin-1' })
    expect(out).toMatch(/human-only/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses calls with no human user context', async () => {
    const out = await executeRegisteredTool(tool, args, { prisma: prismaDouble })
    expect(out).toMatch(/human-only/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not contact the executor when the review invariants fail (e.g. self-approval)', async () => {
    assertCanReview.mockImplementation(() => { throw new ExecutionReviewError('You cannot review an execution you requested', 403) })
    const out = await executeRegisteredTool(tool, args, { prisma: prismaDouble, userId: 'admin-1' })
    expect(out).toMatch(/cannot review an execution you requested/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards human decisions to the executor with reviewerId, keyed by the ORION row id', async () => {
    const out = await executeRegisteredTool(tool, args, { prisma: prismaDouble, userId: 'admin-1' })
    expect(out).toMatch(tool === 'approve_execution' ? /approved/ : /denied/)
    expect(assertCanReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'row-1' }),
      expect.objectContaining({ id: 'admin-1', role: 'admin' }),
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://executor/executions/row-1/review')
    expect(JSON.parse(init.body)).toEqual({
      decision: tool === 'approve_execution' ? 'approved' : 'denied',
      reason: 'reviewed',
      reviewerId: 'admin-1',
    })
    expect(init.headers['x-executor-token']).toBe('exec-token')
  })
})
