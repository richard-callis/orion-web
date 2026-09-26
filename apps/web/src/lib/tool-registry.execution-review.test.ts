/**
 * approve_execution / deny_execution are human-only (SOC2 H1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { reviewExecution } = vi.hoisted(() => ({ reviewExecution: vi.fn() }))

vi.mock('@/lib/execution-review', () => ({
  reviewExecution,
  ExecutionReviewError: class ExecutionReviewError extends Error {
    constructor(message: string, public status: number) { super(message) }
  },
}))

import { executeRegisteredTool, type ToolExecutionContext } from './tool-registry'

const userFindUnique = vi.fn()
const prismaDouble = { user: { findUnique: userFindUnique } } as unknown as ToolExecutionContext['prisma']
const args = { executionId: 'exec-1', reason: 'reviewed' }

beforeEach(() => {
  reviewExecution.mockReset().mockResolvedValue({ executionId: 'exec-1' })
  userFindUnique.mockReset().mockResolvedValue({
    id: 'admin-1', username: 'admin', email: 'a@x', name: null, role: 'admin', active: true,
  })
})

describe.each(['approve_execution', 'deny_execution'])('%s', (tool) => {
  it('refuses calls from an agent (MCP / room agent path)', async () => {
    const out = await executeRegisteredTool(tool, args, { prisma: prismaDouble, agentId: 'agent-1' })
    expect(out).toMatch(/human-only/)
    expect(reviewExecution).not.toHaveBeenCalled()
  })

  it('refuses calls from a task run, even with a user attached', async () => {
    const out = await executeRegisteredTool(tool, args, { prisma: prismaDouble, taskId: 't-1', userId: 'admin-1' })
    expect(out).toMatch(/human-only/)
    expect(reviewExecution).not.toHaveBeenCalled()
  })

  it('refuses calls with no human user context', async () => {
    const out = await executeRegisteredTool(tool, args, { prisma: prismaDouble })
    expect(out).toMatch(/human-only/)
  })

  it('delegates human calls to reviewExecution with the DB user as reviewer', async () => {
    await executeRegisteredTool(tool, args, { prisma: prismaDouble, userId: 'admin-1' })
    expect(reviewExecution).toHaveBeenCalledWith(expect.objectContaining({
      id: 'exec-1',
      reviewer: expect.objectContaining({ id: 'admin-1', role: 'admin' }),
      decision: tool === 'approve_execution' ? 'approved' : 'denied',
    }))
  })
})
