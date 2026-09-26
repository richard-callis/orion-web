/**
 * checkToolPermission — untrusted (webhook-created) task gate (SOC2 M3)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { db, defs } = vi.hoisted(() => ({
  db: {
    agentEnvironment: { findFirst: vi.fn() },
    toolAgentRestriction: { findMany: vi.fn(), findFirst: vi.fn() },
    toolGroupTool: { findMany: vi.fn(), findFirst: vi.fn() },
    agentGroupToolAccess: { findFirst: vi.fn() },
    task: { findUnique: vi.fn(), findFirst: vi.fn() },
    toolExecutionGrant: { findFirst: vi.fn(), update: vi.fn() },
    toolApprovalRequest: { findFirst: vi.fn(), create: vi.fn() },
  },
  defs: {
    orion_list_tasks: { tier: 'read' },
    orion_create_task: { tier: 'write' },
    orion_archive_agent: { tier: 'destructive' },
  } as Record<string, { tier: string }>,
}))

vi.mock('@/lib/db', () => ({ prisma: db }))
vi.mock('@/lib/tool-registry', () => ({ getToolDefinition: (name: string) => defs[name] }))

import { checkToolPermission } from './tool-permissions'

beforeEach(() => {
  db.agentEnvironment.findFirst.mockReset().mockResolvedValue({ environmentId: 'env-1' })
  db.toolAgentRestriction.findMany.mockReset().mockResolvedValue([])
  db.toolAgentRestriction.findFirst.mockReset().mockResolvedValue(null)
  db.toolGroupTool.findMany.mockReset().mockResolvedValue([])
  db.toolGroupTool.findFirst.mockReset().mockResolvedValue(null)
  db.agentGroupToolAccess.findFirst.mockReset().mockResolvedValue(null)
  db.task.findUnique.mockReset().mockResolvedValue({ metadata: {} })
  db.task.findFirst.mockReset().mockResolvedValue(null)
  db.toolExecutionGrant.findFirst.mockReset().mockResolvedValue(null)
  db.toolExecutionGrant.update.mockReset().mockResolvedValue({})
  db.toolApprovalRequest.findFirst.mockReset().mockResolvedValue(null)
  db.toolApprovalRequest.create.mockReset().mockResolvedValue({})
})

describe('trusted tasks (unchanged behaviour)', () => {
  it('allows write-tier and gateway tools', async () => {
    expect((await checkToolPermission('orion_create_task', 'agent-1', null, undefined, { taskId: 't-1' })).allowed).toBe(true)
    expect((await checkToolPermission('kubectl_get', 'agent-1', null, undefined, { taskId: 't-1' })).allowed).toBe(true)
  })
})

describe('untrusted tasks', () => {
  beforeEach(() => {
    db.task.findUnique.mockResolvedValue({ metadata: { untrusted: true, source: 'webhook' } })
  })

  it('still allows registry read-tier tools without a grant', async () => {
    const res = await checkToolPermission('orion_list_tasks', 'agent-1', null, undefined, { taskId: 't-1' })
    expect(res.allowed).toBe(true)
    expect(db.task.findUnique).not.toHaveBeenCalled()
  })

  it('requires a grant for write-tier registry tools and files an approval request', async () => {
    const res = await checkToolPermission('orion_create_task', 'agent-1', null, undefined, { taskId: 't-1' })
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/untrusted/)
    expect(db.toolApprovalRequest.create).toHaveBeenCalledOnce()
  })

  it('requires a grant for gateway tools (no tier metadata)', async () => {
    const res = await checkToolPermission('kubectl_delete', 'agent-1', null, undefined, { taskId: 't-1' })
    expect(res.allowed).toBe(false)
  })

  it('consumes a one-time grant when an admin approved the tool', async () => {
    db.toolExecutionGrant.findFirst.mockResolvedValue({ id: 'grant-1' })
    const res = await checkToolPermission('orion_create_task', 'agent-1', null, undefined, { taskId: 't-1' })
    expect(res.allowed).toBe(true)
    expect(db.toolExecutionGrant.update).toHaveBeenCalledWith({ where: { id: 'grant-1' }, data: { usedAt: expect.any(Date) } })
  })

  it('denies when there is no environment context to scope a grant', async () => {
    db.agentEnvironment.findFirst.mockResolvedValue(null)
    const res = await checkToolPermission('orion_create_task', 'agent-1', null, undefined, { taskId: 't-1' })
    expect(res.allowed).toBe(false)
  })
})

describe('MCP path (no taskId)', () => {
  it("falls back to the agent's in-progress untrusted tasks", async () => {
    db.task.findFirst.mockResolvedValue({ id: 't-webhook' })
    const res = await checkToolPermission('orion_create_task', 'agent-1', null)
    expect(res.allowed).toBe(false)
    expect(db.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ assignedAgent: 'agent-1', status: 'in_progress' }),
    }))
  })

  it('allows when the agent has no untrusted task in progress', async () => {
    const res = await checkToolPermission('orion_create_task', 'agent-1', null)
    expect(res.allowed).toBe(true)
  })
})
