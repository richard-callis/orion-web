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

vi.mock('@/lib/db', () => ({
  prisma: {
    actionAudit: {
      findMany: (...a: unknown[]) => actionAudit_findMany(a[0]),
      findUnique: (...a: unknown[]) => actionAudit_findUnique(a[0]),
      update: (...a: unknown[]) => actionAudit_update(a[0] as { data: Record<string, unknown> }),
    },
  },
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
    // Implementation transitions pending → attempting on approve.
    expect(body.status).toBe('attempting')

    // First update writes the approver + post-pending status.
    const firstUpdate = actionAudit_update.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(firstUpdate.data.status).toBe('attempting')
    expect(firstUpdate.data.approvedBy).toBe('admin')
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
    // No mutation when the row is not pending.
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
