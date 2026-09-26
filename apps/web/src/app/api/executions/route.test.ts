/**
 * Tests for /api/executions and /api/executions/[id] — executor-only writes (SOC2 C2)
 *
 * Guards that:
 *  - POST/PATCH reject session users and the gateway token; only x-executor-token passes
 *  - POST idempotency returns the existing row only while it is freshly pending (409 otherwise)
 *  - PATCH can never record an approval or a reviewer identity
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const { toolExecution, sessionUser } = vi.hoisted(() => ({
  toolExecution: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  sessionUser: { id: 'user-1', username: 'u', email: '', name: null, role: 'user', active: true },
}))

vi.mock('@/lib/db', () => ({
  prisma: { toolExecution },
}))

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

  it('refuses to record an approval even from the executor', async () => {
    const res = await PATCH(req('PATCH', { reviewDecision: 'approved' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(403)
    expect(toolExecution.update).not.toHaveBeenCalled()
  })

  it('refuses to set reviewerId from the executor', async () => {
    const res = await PATCH(req('PATCH', { status: 'denied', reviewDecision: 'denied', reviewerId: 'user-2' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(403)
  })

  it('lets the executor record a TTL auto-deny', async () => {
    const res = await PATCH(req('PATCH', { status: 'denied', reviewDecision: 'denied' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(200)
    expect(toolExecution.update).toHaveBeenCalledOnce()
  })

  it('lets the executor record completion', async () => {
    const res = await PATCH(req('PATCH', { status: 'completed', exitCode: 0, output: 'ok' }, { 'x-executor-token': EXECUTOR_TOKEN }), params)
    expect(res.status).toBe(200)
    const call = toolExecution.update.mock.calls[0][0]
    expect(call.data).toMatchObject({ status: 'completed', exitCode: 0, output: 'ok' })
  })
})
