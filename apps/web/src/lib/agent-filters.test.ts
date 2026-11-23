import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const { taskFindMany } = vi.hoisted(() => ({ taskFindMany: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: { task: { findMany: taskFindMany } } }))
vi.mock('@/lib/default-model', () => ({ getDefaultModelId: vi.fn() }))
vi.mock('@/workers/task-claim', () => ({ claimTask: vi.fn() }))
vi.mock('@/worker/task/run-task', () => ({ runTask: vi.fn() }))
vi.mock('@/worker/log', () => ({ log: vi.fn(), err: vi.fn() }))

import { notArchivedAgentWhere } from './agent-filters'
import { pollOnce } from '@/worker/poll'
import { orionCreateAgentTool } from './tools/agents'

const expected = {
  OR: [
    { metadata: { equals: Prisma.DbNull } },
    { metadata: { path: ['archived'], equals: Prisma.DbNull } },
    { metadata: { path: ['archived'], not: true } },
  ],
}

describe('notArchivedAgentWhere', () => {
  it('keeps NULL metadata, a missing archived key, and archived != true', () => {
    expect(notArchivedAgentWhere()).toEqual(expected)
  })

  it('is not the naive NOT(equals true) form, which excludes agents lacking the key', () => {
    expect(JSON.stringify(notArchivedAgentWhere())).not.toContain('"NOT"')
  })
})

describe('call sites', () => {
  beforeEach(() => taskFindMany.mockReset())

  it('worker poll filters tasks by agent through notArchivedAgentWhere', async () => {
    taskFindMany.mockResolvedValue([])
    await pollOnce()
    expect(taskFindMany).toHaveBeenCalledTimes(1)
    const where = taskFindMany.mock.calls[0][0].where
    expect(where.status).toBe('pending')
    expect(where.agent).toEqual(notArchivedAgentWhere())
  })

  it('create_agent counts active agents through notArchivedAgentWhere', async () => {
    const count = vi.fn().mockResolvedValue(50)
    const findUnique = vi.fn().mockResolvedValue(null)
    const result = await orionCreateAgentTool.handler(
      { name: 'x-agent', role: 'tester', systemPrompt: 'You are a test agent used in unit tests.' },
      { prisma: { agent: { count, findUnique } } } as never,
    )
    expect(count).toHaveBeenCalledWith({ where: notArchivedAgentWhere() })
    expect(result).toContain('maximum active agent limit')
  })

  it('create_agent returns an existing agent by name even when the roster is full', async () => {
    const count = vi.fn().mockResolvedValue(50)
    const findUnique = vi.fn().mockResolvedValue({ id: 'a1', name: 'x-agent', role: 'tester', metadata: {} })
    const result = await orionCreateAgentTool.handler(
      { name: 'x-agent', role: 'tester', systemPrompt: 'You are a test agent used in unit tests.' },
      { prisma: { agent: { count, findUnique } } } as never,
    )
    expect(count).not.toHaveBeenCalled()
    expect(result).toContain('Agent already exists')
  })
})
