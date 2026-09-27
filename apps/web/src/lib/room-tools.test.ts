import { describe, it, expect, vi, beforeEach } from 'vitest'

const reg = vi.hoisted(() => {
  const store = new Map<string, any>()
  return {
    store,
    registerTool: vi.fn((def: any) => { store.set(def.name, def) }),
    getAllTools: () => Array.from(store.values()),
    getToolDefinition: (name: string) => store.get(name),
    executeRegisteredTool: vi.fn(),
  }
})
const db = vi.hoisted(() => ({
  agent:          { findUnique: vi.fn() },
  chatRoomMember: { create: vi.fn() },
  chatMessage:    { create: vi.fn() },
  agentMessage:   { create: vi.fn() },
  environment:    { findMany: vi.fn() },
}))

vi.mock('./tool-registry', () => reg)
vi.mock('./db', () => ({ prisma: db }))
vi.mock('./vault', () => ({ updateVaultSecret: vi.fn() }))
vi.mock('./system-cache', () => ({ getOrFetch: (_k: string, _t: string, fn: () => unknown) => fn() }))

import { ROOM_TOOL_NAMES, getRoomAgentTools, buildRoomToolSchemas } from './room-tools'

const ctx = (extra: Record<string, unknown> = {}) => ({ agentId: 'caller', prisma: db as any, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  db.agentMessage.create.mockResolvedValue({})
  db.chatRoomMember.create.mockResolvedValue({})
  db.chatMessage.create.mockResolvedValue({})
  db.environment.findMany.mockResolvedValue([{ name: 'prod' }])
})

describe('room tool registration', () => {
  it('registers the former agent-tools handlers as room-only registry tools', () => {
    for (const name of ['create_task', 'update_task', 'orion_manage_task', 'create_agent', 'write_secret', 'update_secret', 'delete_secret', 'investigation_merge']) {
      expect(ROOM_TOOL_NAMES.has(name)).toBe(true)
      expect(reg.store.get(name)?.availableIn).toBe('room')
    }
    // Deleting a secret record now goes through the destructive-tier grant path
    expect(reg.store.get('delete_secret').tier).toBe('destructive')
    // Duplicates of registry tools were dropped, not re-registered
    expect(ROOM_TOOL_NAMES.has('orion_get_agents')).toBe(false)
    expect(ROOM_TOOL_NAMES.has('generate_secret')).toBe(false)
  })

  it('offers chat/both/room tools to room agents but not task-only tools', () => {
    reg.store.set('task_only_tool', { name: 'task_only_tool', availableIn: 'task', inputSchema: {} })
    reg.store.set('shared_tool',    { name: 'shared_tool',    availableIn: 'both', inputSchema: {} })
    const names = getRoomAgentTools().map(t => t.name)
    expect(names).toContain('shared_tool')
    expect(names).toContain('create_agent')
    expect(names).not.toContain('task_only_tool')
    reg.store.delete('task_only_tool'); reg.store.delete('shared_tool')
  })

  it('injects live environment names into the write_secret schema', async () => {
    const schemas = await buildRoomToolSchemas()
    const ws = schemas.find(s => s.function.name === 'write_secret')!
    const env = (ws.function.parameters.properties as any).environmentName
    expect(env.description).toContain('"prod"')
  })
})

describe('room tool handlers', () => {
  it('refuse to run outside a chat room', async () => {
    const out = await reg.store.get('create_task').handler({ title: 't' }, ctx())
    expect(out).toMatch(/only available to agents in a chat room/)
  })

  it('create_agent delegates to orion_create_agent and invites the new agent', async () => {
    db.agent.findUnique.mockResolvedValue({ metadata: { contextConfig: { llm: 'ext:model-1' } } })
    reg.executeRegisteredTool.mockResolvedValue(JSON.stringify({ id: 'new-1', name: 'Scribe', role: 'Writer' }))

    const out = await reg.store.get('create_agent').handler(
      { name: 'Scribe', systemPrompt: 'You write concise release notes for the team.' },
      ctx({ roomId: 'room-1' }),
    )

    expect(reg.executeRegisteredTool).toHaveBeenCalledWith('orion_create_agent', expect.objectContaining({
      name: 'Scribe', llm: 'ext:model-1',
    }), expect.objectContaining({ roomId: 'room-1', agentId: 'caller' }))
    expect(db.chatRoomMember.create).toHaveBeenCalledWith({ data: { roomId: 'room-1', agentId: 'new-1', role: 'member' } })
    expect(out).toContain('Agent created and invited')
  })

  it('create_agent surfaces registry guardrail errors and does not invite', async () => {
    db.agent.findUnique.mockResolvedValue(null)
    reg.executeRegisteredTool.mockResolvedValue('Error: "admin" is a reserved agent name')

    const out = await reg.store.get('create_agent').handler(
      { name: 'admin', systemPrompt: 'x'.repeat(40) },
      ctx({ roomId: 'room-1' }),
    )
    expect(out).toMatch(/reserved/)
    expect(db.chatRoomMember.create).not.toHaveBeenCalled()
  })

  it('create_agent does not re-invite an existing agent', async () => {
    db.agent.findUnique.mockResolvedValue(null)
    reg.executeRegisteredTool.mockResolvedValue(JSON.stringify({ id: 'a1', name: 'Scribe', note: 'Agent already exists — returning existing record' }))
    const out = await reg.store.get('create_agent').handler({ name: 'Scribe', systemPrompt: 'x'.repeat(40) }, ctx({ roomId: 'r' }))
    expect(out).toMatch(/already exists/)
    expect(db.chatRoomMember.create).not.toHaveBeenCalled()
  })
})
