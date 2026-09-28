/**
 * H2: ORION_EXECUTOR_TOKEN is accepted for the executor's own calls only.
 *
 * Covers both the path matrix (lib/executor-scope.ts) and the real middleware:
 * an x-executor-token must get through for execution records / the room notice /
 * the execution-room setting, and be treated as "no credentials" everywhere else.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { isExecutorAllowedRequest } from './executor-scope'

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => null) }))
vi.mock('./security/crowdsec-bouncer', () => ({ isIpBlocked: vi.fn(async () => false) }))
vi.mock('./rate-limit-redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rate-limit-redis')>()
  return {
    ...actual,
    rateLimitRedis: vi.fn(async (_k: string, limit: number) => ({
      allowed: true, remaining: limit, resetAt: new Date(Date.now() + 60_000), limit,
    })),
  }
})

describe('isExecutorAllowedRequest', () => {
  it.each([
    ['POST', '/api/executions'],
    ['GET', '/api/executions'],
    ['GET', '/api/executions/abc'],
    ['PATCH', '/api/executions/abc'],
    ['POST', '/api/chatrooms/room-1/messages'],
    ['GET', '/api/system-settings/system.room.execution'],
  ])('allows %s %s', (method, path) => {
    expect(isExecutorAllowedRequest(method, path)).toBe(true)
  })

  it.each([
    ['DELETE', '/api/executions/abc'],
    ['POST', '/api/executions/abc/review'],
    ['POST', '/api/executions/abc'],
    ['GET', '/api/chatrooms/room-1/messages'],
    ['POST', '/api/chatrooms/room-1/messages/extra'],
    ['GET', '/api/system-settings/system.room.security'],
    ['GET', '/api/system-settings/vault.rootToken'],
    ['GET', '/api/system-settings/%E0%A4%A'],
    ['PUT', '/api/system-settings/system.room.execution'],
    ['GET', '/api/notes'],
    ['POST', '/api/tasks'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/environments'],
    ['GET', '/api/executionsX'],
  ])('rejects %s %s', (method, path) => {
    expect(isExecutorAllowedRequest(method, path)).toBe(false)
  })
})

describe('middleware with x-executor-token', () => {
  const EXECUTOR_TOKEN = 'executor-token-0123456789'

  beforeEach(() => {
    process.env.ORION_EXECUTOR_TOKEN = EXECUTOR_TOKEN
    process.env.ORION_GATEWAY_TOKEN = 'gateway-token-abcdef'
    process.env.NEXTAUTH_SECRET = 'test-secret'
  })
  afterEach(() => {
    delete process.env.ORION_EXECUTOR_TOKEN
    delete process.env.ORION_GATEWAY_TOKEN
  })

  async function call(method: string, path: string, token = EXECUTOR_TOKEN) {
    const { proxy } = await import('../proxy')
    return proxy(new NextRequest(`http://orion.test${path}`, {
      method,
      headers: { 'x-executor-token': token },
    }))
  }

  function passedThrough(res: Response) {
    // NextResponse.next() sets x-middleware-next; a redirect/401 does not.
    return res.headers.get('x-middleware-next') === '1'
  }

  it.each([
    ['POST', '/api/executions'],
    ['PATCH', '/api/executions/row-1'],
    ['POST', '/api/chatrooms/room-1/messages'],
    ['GET', '/api/system-settings/system.room.execution'],
  ])('passes %s %s', async (method, path) => {
    expect(passedThrough(await call(method, path))).toBe(true)
  })

  it.each([
    ['GET', '/api/notes'],
    ['GET', '/api/environments'],
    ['GET', '/api/system-settings/system.room.security'],
    ['POST', '/api/tasks'],
    ['GET', '/api/chatrooms/room-1/messages'],
    ['DELETE', '/api/executions/row-1'],
    ['POST', '/api/executions/row-1/review'],
  ])('refuses %s %s (falls through to session auth → login)', async (method, path) => {
    const res = await call(method, path)
    expect(passedThrough(res)).toBe(false)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })

  it('refuses a wrong executor token even on an executor path', async () => {
    const res = await call('POST', '/api/executions', 'executor-token-WRONGWRONG')
    expect(passedThrough(res)).toBe(false)
  })
})
