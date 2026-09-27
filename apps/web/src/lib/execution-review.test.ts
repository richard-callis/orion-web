/**
 * Tests for reviewExecution — human-only, no self-approval (SOC2 C2/H1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { toolExecution, logAudit } = vi.hoisted(() => ({
  toolExecution: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  logAudit: vi.fn(async (..._a: unknown[]) => {}),
}))
vi.mock('@/lib/db', () => ({ prisma: { toolExecution } }))

vi.mock('@/lib/audit', () => ({ logAudit }))

import { reviewExecution, ExecutionReviewError } from './execution-review'

const admin = { id: 'admin-1', username: 'admin', email: '', name: null, role: 'admin', active: true }
const pendingRow = {
  id: 'exec-row-1',
  executionId: '11111111-1111-1111-1111-111111111111',
  tool: 'shell_exec',
  actorId: 'user-1',
  status: 'pending',
  reviewDecision: null,
  expiresAt: new Date(Date.now() + 60_000),
}

async function expectReviewError(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toBeInstanceOf(ExecutionReviewError)
  await p.catch((e: ExecutionReviewError) => expect(e.status).toBe(status))
}

beforeEach(() => {
  toolExecution.findFirst.mockReset().mockResolvedValue(pendingRow)
  toolExecution.findUnique.mockReset().mockResolvedValue({ ...pendingRow, reviewDecision: 'approved' })
  toolExecution.updateMany.mockReset().mockResolvedValue({ count: 1 })
  logAudit.mockClear()
})

describe('reviewExecution', () => {
  it('rejects non-admin reviewers', async () => {
    await expectReviewError(
      reviewExecution({ id: 'exec-row-1', reviewer: { ...admin, role: 'user' }, decision: 'approved', reason: 'ok' }),
      403,
    )
    expect(toolExecution.updateMany).not.toHaveBeenCalled()
  })

  it('rejects self-approval by the requesting actor, even an admin', async () => {
    toolExecution.findFirst.mockResolvedValue({ ...pendingRow, actorId: 'admin-1' })
    await expectReviewError(
      reviewExecution({ id: 'exec-row-1', reviewer: admin, decision: 'approved', reason: 'ok' }),
      403,
    )
    expect(toolExecution.updateMany).not.toHaveBeenCalled()
  })

  it('rejects admins with MFA enabled but not verified in this session', async () => {
    await expectReviewError(
      reviewExecution({ id: 'exec-row-1', reviewer: { ...admin, totpEnabled: true, mfaVerified: false }, decision: 'approved', reason: 'ok' }),
      403,
    )
  })

  it('requires a reason', async () => {
    await expectReviewError(
      reviewExecution({ id: 'exec-row-1', reviewer: admin, decision: 'approved', reason: '  ' }),
      400,
    )
  })

  it('returns 404 for an unknown execution', async () => {
    toolExecution.findFirst.mockResolvedValue(null)
    await expectReviewError(
      reviewExecution({ id: 'nope', reviewer: admin, decision: 'approved', reason: 'ok' }),
      404,
    )
  })

  it('rejects an execution that was already reviewed', async () => {
    toolExecution.findFirst.mockResolvedValue({ ...pendingRow, reviewDecision: 'denied' })
    await expectReviewError(
      reviewExecution({ id: 'exec-row-1', reviewer: admin, decision: 'approved', reason: 'ok' }),
      409,
    )
  })

  it('rejects an expired execution', async () => {
    toolExecution.findFirst.mockResolvedValue({ ...pendingRow, expiresAt: new Date(Date.now() - 1000) })
    await expectReviewError(
      reviewExecution({ id: 'exec-row-1', reviewer: admin, decision: 'approved', reason: 'ok' }),
      409,
    )
  })

  it('loses a concurrent review race cleanly', async () => {
    toolExecution.updateMany.mockResolvedValue({ count: 0 })
    await expectReviewError(
      reviewExecution({ id: 'exec-row-1', reviewer: admin, decision: 'approved', reason: 'ok' }),
      409,
    )
  })

  it('records the reviewer with a compare-and-set and audit-logs the approval', async () => {
    await reviewExecution({ id: pendingRow.executionId, reviewer: admin, decision: 'approved', reason: 'looks safe' })

    expect(toolExecution.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: pendingRow.executionId }, { executionId: pendingRow.executionId }] },
    })
    const call = toolExecution.updateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'exec-row-1', status: 'pending', reviewDecision: null })
    expect(call.data).toMatchObject({ reviewerId: 'admin-1', reviewDecision: 'approved' })
    expect(call.data.status).toBeUndefined()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1',
      action: 'execution_approve',
      target: 'execution:exec-row-1',
    }))
  })

  it('marks denials as terminal', async () => {
    await reviewExecution({ id: 'exec-row-1', reviewer: admin, decision: 'denied', reason: 'no' })
    const call = toolExecution.updateMany.mock.calls[0][0]
    expect(call.data).toMatchObject({ reviewDecision: 'denied', status: 'denied' })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'execution_deny' }))
  })
})
