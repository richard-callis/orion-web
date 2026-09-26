/**
 * Tests for the approvals API routes — locks in the status='pending'
 * semantics from PR #410 / #413 (B3).
 *
 * The previous bug queried `status='denied'` for pending approvals, which is
 * a terminal state. After PR #410's B3 fix, action-service writes 'pending'
 * for tier='approve' awaiting-operator rows; the GET route must read the
 * same state and the POST route must accept it (rejecting any other status).
 *
 * Regression guard: if you see this test failing with "status='denied'"
 * appearing in the where clause or in the status check, the bug has
 * regressed — do NOT relax these expectations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Prisma double ────────────────────────────────────────────────────────────
const actionAudit_findMany = vi.fn(async (_args: unknown) => [] as unknown[])
const actionAudit_findUnique = vi.fn(async (_args: unknown) => null as unknown)
const actionAudit_update = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: 'audit-1',
  ...args.data,
}))
// Atomic compare-and-set used by the POST route: only transitions a 'pending' row.
const actionAudit_updateMany = vi.fn(async (_args: unknown) => ({ count: 0 }))
const gatewayExecutorMock = vi.fn(async (..._a: unknown[]) => ({ success: true, result: 'ok' }))

vi.mock('@/lib/db', () => ({
  prisma: {
    actionAudit: {
      findMany: (...a: unknown[]) => actionAudit_findMany(a[0]),
      findUnique: (...a: unknown[]) => actionAudit_findUnique(a[0]),
      update: (...a: unknown[]) => actionAudit_update(a[0] as { data: Record<string, unknown> }),
      updateMany: (...a: unknown[]) => actionAudit_updateMany(a[0]),
    },
  },
}))

vi.mock('@/lib/security/action-service', () => ({
  gatewayExecutor: (...a: unknown[]) => gatewayExecutorMock(...a),
}))

// requireAdmin must succeed for the POST tests.
const requireAdminMock = vi.fn(async () => ({ id: 'u1', username: 'admin' }))
vi.mock('@/lib/auth', () => ({
  requireAdmin: (...a: unknown[]) => requireAdminMock(...a),
}))

import { NextRequest } from 'next/server'
import { GET as listApprovals } from './route'
import { POST as decideApproval } from './[id]/route'

function buildReq(url: string, init?: { body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  })
}

beforeEach(() => {
  actionAudit_findMany.mockReset().mockResolvedValue([])
  actionAudit_findUnique.mockReset().mockResolvedValue(null)
  actionAudit_update.mockReset().mockResolvedValue({})
  // Simulate the DB: the CAS only matches while the row is still 'pending'.
  actionAudit_updateMany.mockReset().mockImplementation(async () => {
    const row = (await actionAudit_findUnique.mock.results.at(-1)?.value) as { status?: string } | null
    return { count: row?.status === 'pending' ? 1 : 0 }
  })
  gatewayExecutorMock.mockReset().mockResolvedValue({ success: true, result: 'ok' })
  requireAdminMock.mockReset().mockResolvedValue({ id: 'u1', username: 'admin' })
})

describe('GET /api/monitoring/security/approvals — pending-status query (B3)', () => {
  it("queries status='pending', NOT 'denied'", async () => {
    actionAudit_findMany.mockResolvedValue([
      {
        id: 'audit-1',
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
        tier: 'approve',
        proposedBy: 'warden',
        incidentId: null,
        payload: {},
        createdAt: new Date('2026-01-01'),
        incident: null,
      },
    ])

    const res = await listApprovals(buildReq('http://x/api/monitoring/security/approvals'))
    expect(res.status).toBe(200)

    // The Prisma call must filter by status='pending' (regression guard for B3).
    const where = (actionAudit_findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })?.where
    expect(where.status).toBe('pending')
    expect(where.status).not.toBe('denied')
    expect(where.tier).toBe('approve')
  })

  it('returns pending rows in the response payload', async () => {
    actionAudit_findMany.mockResolvedValue([
      {
        id: 'audit-1',
        actionType: 'crowdsec_decision_create',
        target: '1.2.3.4',
        tier: 'approve',
        proposedBy: 'warden',
        incidentId: 'inc-1',
        payload: { duration: '1h' },
        createdAt: new Date('2026-01-01'),
        incident: { severity: 80, rootCauseSummary: 'brute force', attackerKey: '1.2.3.4' },
      },
    ])

    const res = await listApprovals(buildReq('http://x/api/monitoring/security/approvals'))
    const body = (await res.json()) as { pending: unknown[]; count: number }
    expect(body.count).toBe(1)
    expect((body.pending[0] as { id: string }).id).toBe('audit-1')
  })
})

describe('POST /api/monitoring/security/approvals/[id] — accepts pending only (B3)', () => {
  it('approves a pending row (transitions out of pending)', async () => {
    actionAudit_findUnique.mockResolvedValue({
      id: 'audit-1',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
      tier: 'approve',
      status: 'pending', // ← post-B3 starting state
      incidentId: null,
      payload: {},
      environmentId: null,
    })
    actionAudit_update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'audit-1',
      ...args.data,
      incident: null,
    }))

    const res = await decideApproval(
      buildReq('http://x/api/monitoring/security/approvals/audit-1', {
        body: { action: 'approve' },
      }),
      { params: { id: 'audit-1' } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; status: string }
    expect(body.success).toBe(true)
    expect(body.status).toBe('succeeded')

    // The CAS only transitions a row that is still 'pending', recording the approver.
    const cas = actionAudit_updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> }
    expect(cas.where).toEqual({ id: 'audit-1', status: 'pending' })
    expect(cas.data.status).toBe('attempting')
    expect(cas.data.approvedBy).toBe('admin')

    // The gateway call carries the audit id so a decision token gets minted.
    const execPayload = gatewayExecutorMock.mock.calls[0]?.[2] as Record<string, unknown>
    expect(execPayload.__auditId).toBe('audit-1')
    const finalUpdate = actionAudit_update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }
    expect(finalUpdate.data.status).toBe('succeeded')
  })

  it("rejects rows that are NOT in 'pending' (denies the regression path)", async () => {
    actionAudit_findUnique.mockResolvedValue({
      id: 'audit-1',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
      tier: 'approve',
      status: 'denied', // a terminal state — must not be accepted as pending
      incidentId: null,
      payload: {},
      environmentId: null,
    })

    const res = await decideApproval(
      buildReq('http://x/api/monitoring/security/approvals/audit-1', {
        body: { action: 'approve' },
      }),
      { params: { id: 'audit-1' } },
    )
    expect(res.status).toBe(409)
    // No execution and no further writes when the row is not pending.
    expect(gatewayExecutorMock).not.toHaveBeenCalled()
    expect(actionAudit_update).not.toHaveBeenCalled()
  })

  it('denies a pending row (transitions pending → denied)', async () => {
    actionAudit_findUnique.mockResolvedValue({
      id: 'audit-1',
      actionType: 'crowdsec_decision_create',
      target: '1.2.3.4',
      tier: 'approve',
      status: 'pending',
      incidentId: null,
      payload: {},
      environmentId: null,
    })
    actionAudit_update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'audit-1',
      ...args.data,
      incident: null,
    }))

    const res = await decideApproval(
      buildReq('http://x/api/monitoring/security/approvals/audit-1', {
        body: { action: 'deny', note: 'false positive' },
      }),
      { params: { id: 'audit-1' } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; status: string }
    expect(body.status).toBe('denied')
    const cas = actionAudit_updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(cas.data.status).toBe('denied')
    expect(gatewayExecutorMock).not.toHaveBeenCalled()
  })

  it('returns 401 when not admin', async () => {
    requireAdminMock.mockRejectedValue(new Error('forbidden'))
    const res = await decideApproval(
      buildReq('http://x/api/monitoring/security/approvals/audit-1', {
        body: { action: 'approve' },
      }),
      { params: { id: 'audit-1' } },
    )
    expect(res.status).toBe(401)
    expect(actionAudit_findUnique).not.toHaveBeenCalled()
  })
})
