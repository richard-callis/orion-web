/**
 * Tests for POST /api/tasks/:id/resume-plan
 *
 * Guards the plan approval workflow:
 *  - valid pending_validation task → 200, sets status to pending, metadata.planApproved=true
 *  - task in wrong status → 400
 *  - blockedSteps included → metadata contains array, audit event includes descriptions
 *  - non-existent task → 404
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Prisma double ────────────────────────────────────────────────────────────
const task_findUnique = vi.fn(async (_args: unknown) => null as unknown)
const task_update = vi.fn(async (args: { data: Record<string, unknown> }) => ({
  id: 'task-1',
  ...args.data,
}))
const taskEvent_create = vi.fn(async (_args: unknown) => ({}))

vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      findUnique: (...a: unknown[]) => task_findUnique(a[0]),
      update: (...a: unknown[]) => task_update(a[0] as { data: Record<string, unknown> }),
    },
    taskEvent: {
      create: (...a: unknown[]) => taskEvent_create(a[0]),
    },
  },
}))

// Auth doubles
const requireServiceAuthMock = vi.fn(async () => ({ id: 'user-1', username: 'alice', role: 'admin' }))
const assertCanModifyMock = vi.fn(async () => undefined)

vi.mock('@/lib/auth', () => ({
  requireServiceAuth: (...a: unknown[]) => requireServiceAuthMock(...a),
  assertCanModify: (...a: unknown[]) => assertCanModifyMock(...a),
}))

import { POST } from './route'

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    status: 'pending_validation',
    createdBy: 'user-1',
    metadata: { planContent: 'do the thing', planSteps: ['step A', 'step B', 'step C'] },
    plan: null,
    ...overrides,
  }
}

function buildReq(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  task_findUnique.mockReset().mockResolvedValue(null)
  task_update.mockReset().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'task-1',
    ...args.data,
  }))
  taskEvent_create.mockReset().mockResolvedValue({})
  requireServiceAuthMock.mockReset().mockResolvedValue({ id: 'user-1', username: 'alice', role: 'admin' })
  assertCanModifyMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/tasks/:id/resume-plan', () => {
  it('returns 200 and sets status=pending + planApproved=true for a valid pending_validation task', async () => {
    task_findUnique.mockResolvedValue(makeTask())

    const res = await POST(buildReq('http://x/api/tasks/task-1/resume-plan'), { params: { id: 'task-1' } })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { ok: boolean; status: string; id: string }
    expect(body.ok).toBe(true)
    expect(body.status).toBe('pending')
    expect(body.id).toBe('task-1')

    // Verify DB update was called with correct fields
    const updateArgs = task_update.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(updateArgs.data.status).toBe('pending')
    expect((updateArgs.data.metadata as Record<string, unknown>).planApproved).toBe(true)
  })

  it('returns 400 when task is not in pending_validation status', async () => {
    task_findUnique.mockResolvedValue(makeTask({ status: 'pending' }))

    const res = await POST(buildReq('http://x/api/tasks/task-1/resume-plan'), { params: { id: 'task-1' } })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/not awaiting plan approval/i)
    expect(task_update).not.toHaveBeenCalled()
  })

  it('returns 400 for other non-validation statuses (e.g. running)', async () => {
    task_findUnique.mockResolvedValue(makeTask({ status: 'running' }))

    const res = await POST(buildReq('http://x/api/tasks/task-1/resume-plan'), { params: { id: 'task-1' } })
    expect(res.status).toBe(400)
    expect(task_update).not.toHaveBeenCalled()
  })

  it('returns 404 for a non-existent task', async () => {
    task_findUnique.mockResolvedValue(null)

    const res = await POST(buildReq('http://x/api/tasks/nonexistent/resume-plan'), { params: { id: 'nonexistent' } })
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/not found/i)
    expect(task_update).not.toHaveBeenCalled()
  })

  it('stores blockedSteps in metadata when provided', async () => {
    task_findUnique.mockResolvedValue(makeTask())

    const res = await POST(
      buildReq('http://x/api/tasks/task-1/resume-plan', { blockedSteps: [0, 2] }),
      { params: { id: 'task-1' } },
    )
    expect(res.status).toBe(200)

    const responseBody = (await res.json()) as { blockedSteps: number[] }
    expect(responseBody.blockedSteps).toEqual([0, 2])

    // metadata must carry the array
    const updateArgs = task_update.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    const meta = updateArgs.data.metadata as Record<string, unknown>
    expect(meta.blockedSteps).toEqual([0, 2])
  })

  it('includes blocked step descriptions in the audit event when blockedSteps provided', async () => {
    task_findUnique.mockResolvedValue(makeTask())

    await POST(
      buildReq('http://x/api/tasks/task-1/resume-plan', { blockedSteps: [0, 2] }),
      { params: { id: 'task-1' } },
    )

    const eventCreate = taskEvent_create.mock.calls[0]?.[0] as { data: { content: string } }
    // Content should reference blocked step numbers + their descriptions from planSteps
    expect(eventCreate.data.content).toContain('#1')  // blockedSteps[0] → step index 0 = "step A"
    expect(eventCreate.data.content).toContain('step A')
    expect(eventCreate.data.content).toContain('#3')  // blockedSteps[1] → step index 2 = "step C"
    expect(eventCreate.data.content).toContain('step C')
  })

  it('creates a plan_approved audit event', async () => {
    task_findUnique.mockResolvedValue(makeTask())

    await POST(buildReq('http://x/api/tasks/task-1/resume-plan'), { params: { id: 'task-1' } })

    const eventCreate = taskEvent_create.mock.calls[0]?.[0] as { data: { eventType: string; taskId: string } }
    expect(eventCreate.data.eventType).toBe('plan_approved')
    expect(eventCreate.data.taskId).toBe('task-1')
  })
})
