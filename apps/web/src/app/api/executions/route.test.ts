/**
 * Tests for /api/executions and /api/executions/[id] — executor-only writes (SOC2 C2)
 *
 * Guards that:
 *  - POST/PATCH reject session users and the gateway token; only x-executor-token passes
 *  - POST idempotency returns the existing row only while it is freshly pending (409 otherwise)
 *  - PATCH records an approval only with a forwarded reviewerId that is an admin other
 *    than the actor, as a compare-and-set on the still-pending row
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const { toolExecution, user, sessionUser } = vi.hoisted(() => ({
  toolExecution: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  user: { findUnique: vi.fn() },
  sessionUser: { id: 'user-1', username: 'u', email: '', name: null, role: 'user', active: true },
}))

vi.mock('@/lib/db', () => ({
  prisma: { toolExecution, user },
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }))

// Keep the real isExecutorServiceCall; a logged-in session must NOT be enough.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>()
  return {
    ...actual,
    getCurrentUser: vi.fn(async () => sessionUser),
    requireServiceAuth: vi.fn(async () => sessionUser),
  }
})

import { POST } from './route'
import { PATCH } from './[id]/route'

const EXECUTOR_TOKEN = 'executor-secret-token'

function req(method: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://x/api/executions', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ id: 'exec-row-1' }) }

const createBody = {
  executionId: '11111111-1111-1111-1111-111111111111',
  tool: 'shell_exec',
  args: { command: 'uptime' },
  actorId: 'user-1',
  actorType: 'human',
  status: 'pending',
}

beforeEach(() => {
  process.env.ORION_EXECUTOR_TOKEN = EXECUTOR_TOKEN
  process.env.ORION_GATEWAY_TOKEN = 'gateway-token'
  toolExecution.findUnique.mockReset().mockResolvedValue(null)
  toolExecution.create.mockReset().mockImplementation(async ({ data }) => ({ id: 'exec-row-1', ...data }))
  toolExecution.update.mockReset().mockImplementation(async ({ data }) => ({ id: 'exec-row-1', ...data }))
  toolExecution.updateMany.mockReset().mockResolvedValue({ count: 1 })
  user.findUnique.mockReset().mockImplementation(async ({ where }) => (
    where.id === 'admin-1' ? { id: 'admin-1', role: 'admin', active: true }
      : where.id === 'user-1' ? { id: 'user-1', role: 'user', active: true }
      : null
  ))
})

afterEach(() => {
  delete process.env.ORION_EXECUTOR_TOKEN
  delete process.env.ORION_GATEWAY_TOKEN
})

describe('POST /api/executions', () => {
  it('rejects a logged-in session user without the executor token', async () => {
    const res = await POST(req('POST', createBody))
    expect(res.status).toBe(401)
    expect(toolExecution.create).not.toHaveBeenCalled()
  })

  it('rejects the gateway Bearer token', async () => {
    const res = await POST(req('POST', createBody, { authorization: 'Bearer gateway-token' }))
    expect(res.status).toBe(401)
  })

  it('rejects a wrong executor token', async () => {
    const res = await POST(req('POST', createBody, { 'x-executor-token': 'executor-secret-tokeX' }))
    expect(res.status).toBe(401)
  })

  it('rejects when ORION_EXECUTOR_TOKEN is unset, even with an empty header', async () => {
    delete process.env.ORION_EXECUTOR_TOKEN
    const res = await POST(req('POST', createBody, { 'x-executor-token': '' }))
    expect(res.status).toBe(401)
  })

  it('creates a pending execution for the executor', async () => {
    const res = await POST(req('POST', createBody, { 'x-executor-token': EXECUTOR_TOKEN }))
    expect(res.status).toBe(201)
    expect(toolExecution.create).toHaveBeenCalledOnce()
  })

  it('refuses to create an execution in a non-pending status', async () => {
    const res = await POST(req('POST', { ...createBody, status: 'running' }, { 'x-executor-token': EXECUTOR_TOKEN }))
    expect(res.status).toBe(400)
    expect(toolExecution.create).not.toHaveBeenCalled()
  })

  it('returns the existing row for an idempotent retry while still pending', async () => {
    toolExecution.findUnique.mockResolvedValue({ id: 'exec-row-1', status: 'pending', reviewDecision: null })
    const res = await POST(req('POST', createBody, { 'x-executor-token': EXECUTOR_TOKEN }))
    expect(res.status).toBe(200)
  })

  it('returns 409 when replaying an executionId that was already approved', async () => {
    toolExecution.findUnique.mockResolvedValue({ id: 'exec-row-1', status: 'pending', reviewDecision: 'approved' })
    const res = await POST(req('POST', createBody, { 'x-executor-token': EXECUTOR_TOKEN }))
    expect(res.status).toBe(409)
  })

  it('returns 409 when replaying an executionId that already completed', async () => {
    toolExecution.findUnique.mockResolvedValue({ id: 'exec-row-1', status: 'completed', reviewDecision: null })
    const res = await POST(req('POST', createBody, { 'x-executor-token': EXECUTOR_TOKEN }))
    expect(res.status).toBe(409)
  })
})

describe('PATCH /api/executions/[id]', () => {
  beforeEach(() => {
    toolExecution.findUnique.mockResolvedValue({ id: 'exec-row-1', actorId: 'user-1', status: 'pending', reviewDecision: null })
  })

  it('rejects the actor self-approving through their session', async () => {
    const res = await PATCH(req('PATCH', { reviewDecision: 'approved' }), params)
    expect(res.status).toBe(401)
    expect(toolExecution.update).not.toHaveBeenCalled()
  })

  it('refuses an approval without a reviewerId, even from the executor', async () => {
    const res = await PATCH(req('PATCH', { reviewDecision: 'approved' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(400)
    expect(toolExecution.updateMany).not.toHaveBeenCalled()
  })

  it('refuses a forwarded self-approval (reviewer == actor)', async () => {
    toolExecution.findUnique.mockResolvedValue({ id: 'exec-row-1', actorId: 'admin-1', status: 'pending', reviewDecision: null })
    const res = await PATCH(req('PATCH', { reviewDecision: 'approved', reviewerId: 'admin-1' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(403)
    expect(toolExecution.updateMany).not.toHaveBeenCalled()
  })

  it('refuses a forwarded approval by a non-admin reviewer', async () => {
    toolExecution.findUnique.mockResolvedValue({ id: 'exec-row-1', actorId: 'agent-1', status: 'pending', reviewDecision: null })
    const res = await PATCH(req('PATCH', { reviewDecision: 'approved', reviewerId: 'user-1' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(403)
  })

  it('refuses a forwarded approval by an unknown reviewer', async () => {
    const res = await PATCH(req('PATCH', { reviewDecision: 'approved', reviewerId: 'ghost' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(403)
  })

  it('records a valid forwarded approval as a compare-and-set with the reviewer', async () => {
    const res = await PATCH(req('PATCH', { reviewDecision: 'approved', reviewerId: 'admin-1' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(200)
    const call = toolExecution.updateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'exec-row-1', status: 'pending', reviewDecision: null })
    expect(call.data).toMatchObject({ reviewDecision: 'approved', reviewerId: 'admin-1' })
  })

  it('lets the executor record a TTL auto-deny as a compare-and-set', async () => {
    const res = await PATCH(req('PATCH', { status: 'denied', reviewDecision: 'denied' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(200)
    const call = toolExecution.updateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'exec-row-1', status: 'pending', reviewDecision: null })
    expect(call.data).toMatchObject({ status: 'denied', reviewDecision: 'denied' })
  })

  it('does not let a late auto-deny overwrite a recorded decision', async () => {
    toolExecution.updateMany.mockResolvedValue({ count: 0 })
    const res = await PATCH(req('PATCH', { reviewDecision: 'denied' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(409)
  })

  it('rejects an unknown reviewDecision value', async () => {
    const res = await PATCH(req('PATCH', { reviewDecision: 'maybe' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(400)
  })

  it('lets the executor record completion', async () => {
    const res = await PATCH(req('PATCH', { status: 'completed', exitCode: 0, output: 'ok' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(200)
    const call = toolExecution.update.mock.calls[0][0]
    expect(call.data).toMatchObject({ status: 'completed', exitCode: 0, output: 'ok' })
  })
})
