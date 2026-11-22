import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ agents: vi.fn(), resolve: vi.fn(), run: vi.fn(), feed: vi.fn() }))
vi.mock('@/lib/db', () => {
  const none = { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})), create: vi.fn(async () => ({})) }
  return { prisma: { systemSetting: none, task: none, taskEvent: none, note: none, agent: { ...none, findMany: (a: { where?: unknown }) => (a.where ? m.agents() : Promise.resolve([])) } } }
})
vi.mock('@/lib/agent-runner', () => ({ createRunner: () => ({ run: m.run }) }))
vi.mock('@/lib/embeddings', () => ({ retrieveKnowledgeContext: vi.fn(async () => '') }))
vi.mock('@/lib/management-tools', () => ({ MANAGEMENT_TOOL_DEFS: [], executeManagedTool: vi.fn() }))
vi.mock('@/lib/seed-system-epic', () => ({ getSystemRooms: vi.fn(async () => ({})) }))
vi.mock('@/lib/system-prompts', () => ({ getPrompt: vi.fn(async () => '{{toolList}}') }))
vi.mock('@/lib/agent-gateway', () => ({ resolveAgentGateway: vi.fn(async () => null) }))
vi.mock('@/lib/agents-md', () => ({ getAgentsMd: vi.fn(async () => null) }))
vi.mock('./log', () => ({ log: vi.fn(), err: vi.fn() }))
vi.mock('./db-helpers', () => ({ postToFeed: m.feed }))
vi.mock('./model', () => ({ resolveModelId: m.resolve }))
vi.mock('./tool-scope', () => ({ managementToolLines: () => [] }))

import { runWatchers } from './watchers'
import { runningWatchers } from './state'

const watcher = (id: string, llm: string) => ({ id, name: id, metadata: { contextConfig: { persistent: true, watchPrompt: 'look', llm } } })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.run.mockImplementation(async function* () { yield { type: 'text', content: 'all fine' } })
  runningWatchers.clear()
})

describe('runWatchers', () => {
  it('a watcher whose setup fails is reported and released, and the next one still runs', async () => {
    m.agents.mockResolvedValue([watcher('broken', 'ext:nomic'), watcher('good', 'ext:chat')])
    m.resolve.mockImplementation(async (llm: string) => { if (llm === 'ext:nomic') throw new Error("is an embedding model and can't chat"); return llm })
    await runWatchers()
    expect(m.feed.mock.calls.map(c => c[0])).toEqual(['broken', 'good'])
    expect(m.feed.mock.calls[0][1]).toContain("can't chat")
    expect(m.run).toHaveBeenCalledTimes(1)
    expect([...runningWatchers]).toEqual([])
  })
})
