/**
 * Tests for the human-chat tool permission gate (chat-tool-policy.ts).
 *
 * Covers the review findings this module fixes:
 * - readonly / unauthenticated users can't run any tool
 * - non-admins can't run admin-only tools (orion_patch_environment, …)
 * - destructive tools with no ToolGroup are no longer "unrestricted" for non-admins
 * - admins are allowed
 * - one-time grants and env admin tier still unlock destructive tools
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  user:                  { findUnique: vi.fn() },
  toolAgentRestriction:  { count: vi.fn() },
  mcpTool:               { findFirst: vi.fn() },
  environmentUserTier:   { findUnique: vi.fn() },
  toolGroupTool:         { findMany: vi.fn() },
  toolExecutionGrant:    { findFirst: vi.fn(), updateMany: vi.fn() },
  toolApprovalRequest:   { findFirst: vi.fn(), create: vi.fn() },
}))

vi.mock('./db', () => ({ prisma: db }))

// Minimal registry fixture: tier metadata for the management tools under test.
vi.mock('./tool-registry', () => {
  const tiers: Record<string, 'read' | 'write' | 'destructive'> = {
    orion_patch_environment:     'destructive',
    orion_bootstrap_environment: 'destructive',
    orion_archive_agent:         'destructive',
    orion_list_agents:           'read',
    orion_create_task:           'write',
    approve_execution:           'write',
  }
  return {
    getToolDefinition: (name: string) => (tiers[name] ? { name, tier: tiers[name] } : undefined),
  }
})

import {
  checkChatToolPermission,
  evaluateChatToolPolicy,
  filterToolsForRole,
  normalizeRole,
} from './chat-tool-policy'

const ENV = 'env-1'
const CONVO = 'convo-1'

function asRole(role: string | null) {
  db.user.findUnique.mockResolvedValue(role === null ? null : { role, active: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  db.toolAgentRestriction.count.mockResolvedValue(0)
  db.mcpTool.findFirst.mockResolvedValue({ builtIn: true, execType: 'builtin' })
  db.environmentUserTier.findUnique.mockResolvedValue(null)
  db.toolGroupTool.findMany.mockResolvedValue([])
  db.toolExecutionGrant.findFirst.mockResolvedValue(null)
  db.toolExecutionGrant.updateMany.mockResolvedValue({ count: 1 })
  db.toolApprovalRequest.findFirst.mockResolvedValue(null)
  db.toolApprovalRequest.create.mockResolvedValue({})
})

describe('checkChatToolPermission — readonly / anonymous', () => {
  it('denies every tool for a readonly user, including read-only ones', async () => {
    asRole('readonly')
    for (const tool of ['kubectl_get', 'orion_list_agents', 'kubectl_delete']) {
      const r = await checkChatToolPermission(tool, {}, ENV, CONVO, 'u-ro')
      expect(r.allowed).toBe(false)
    }
    // Denied outright — no approval request is filed on their behalf
    expect(db.toolApprovalRequest.create).not.toHaveBeenCalled()
  })

  it('denies when there is no authenticated user', async () => {
    const r = await checkChatToolPermission('kubectl_get', {}, ENV, CONVO, undefined)
    expect(r.allowed).toBe(false)
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })

  it('denies a deactivated user', async () => {
    db.user.findUnique.mockResolvedValue({ role: 'admin', active: false })
    const r = await checkChatToolPermission('kubectl_get', {}, ENV, CONVO, 'u-off')
    expect(r.allowed).toBe(false)
  })
})

describe('checkChatToolPermission — non-admin user', () => {
  beforeEach(() => asRole('user'))

  it('denies admin-only management tools (C1: orion_patch_environment)', async () => {
    const r = await checkChatToolPermission('orion_patch_environment', { environment_id: ENV, body: { gatewayUrl: 'http://evil' } }, '', CONVO, 'u1')
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/administrators/)
  })

  it('denies approve_execution from chat', async () => {
    const r = await checkChatToolPermission('approve_execution', {}, ENV, CONVO, 'u1')
    expect(r.allowed).toBe(false)
  })

  it('denies an ungrouped destructive gateway tool and files an approval request (H3)', async () => {
    const r = await checkChatToolPermission('kubectl_delete', { name: 'x' }, ENV, CONVO, 'u1')
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/admin/)
    expect(db.toolApprovalRequest.create).toHaveBeenCalledOnce()
  })

  it('denies a destructive registry tool with no environment context', async () => {
    const r = await checkChatToolPermission('orion_archive_agent', { agent_id: 'a' }, '', CONVO, 'u1')
    expect(r.allowed).toBe(false)
    expect(db.toolApprovalRequest.create).not.toHaveBeenCalled()
  })

  it('treats a custom (non-builtin) shell tool as destructive', async () => {
    db.mcpTool.findFirst.mockResolvedValue({ builtIn: false, execType: 'shell' })
    const r = await checkChatToolPermission('my_custom_script', {}, ENV, CONVO, 'u1')
    expect(r.allowed).toBe(false)
  })

  it('allows an ungrouped non-destructive tool', async () => {
    expect((await checkChatToolPermission('kubectl_get', {}, ENV, CONVO, 'u1')).allowed).toBe(true)
    expect((await checkChatToolPermission('orion_create_task', {}, '', CONVO, 'u1')).allowed).toBe(true)
  })

  it('allows a destructive tool when the user has admin tier in the environment', async () => {
    db.environmentUserTier.findUnique.mockResolvedValue({ tier: 'admin' })
    const r = await checkChatToolPermission('kubectl_delete', {}, ENV, CONVO, 'u1')
    expect(r.allowed).toBe(true)
  })

  it('allows a destructive tool once with a one-time grant, consuming it atomically', async () => {
    db.toolExecutionGrant.findFirst.mockResolvedValue({ id: 'g1' })
    const r = await checkChatToolPermission('kubectl_delete', {}, ENV, CONVO, 'u1')
    expect(r.allowed).toBe(true)
    expect(db.toolExecutionGrant.updateMany).toHaveBeenCalledWith({
      where: { id: 'g1', usedAt: null },
      data:  { usedAt: expect.any(Date) },
    })
  })

  it('denies when a concurrent call already consumed the grant', async () => {
    db.toolExecutionGrant.findFirst.mockResolvedValue({ id: 'g1' })
    db.toolExecutionGrant.updateMany.mockResolvedValue({ count: 0 })
    const r = await checkChatToolPermission('kubectl_delete', {}, ENV, CONVO, 'u1')
    expect(r.allowed).toBe(false)
  })

  it('still honours ToolGroup minimum tiers for grouped tools', async () => {
    db.toolGroupTool.findMany.mockResolvedValue([{ toolGroup: { minimumTier: 'operator' } }])
    expect((await checkChatToolPermission('kubectl_get', {}, ENV, CONVO, 'u1')).allowed).toBe(false)
    db.environmentUserTier.findUnique.mockResolvedValue({ tier: 'operator' })
    expect((await checkChatToolPermission('kubectl_get', {}, ENV, CONVO, 'u1')).allowed).toBe(true)
  })

  it('denies agent-restricted tools', async () => {
    db.toolAgentRestriction.count.mockResolvedValue(1)
    const r = await checkChatToolPermission('kubectl_get', {}, ENV, CONVO, 'u1')
    expect(r.allowed).toBe(false)
  })
})

describe('checkChatToolPermission — admin', () => {
  beforeEach(() => asRole('admin'))

  it('allows admin-only and destructive tools', async () => {
    expect((await checkChatToolPermission('orion_patch_environment', {}, '', CONVO, 'a1')).allowed).toBe(true)
    expect((await checkChatToolPermission('kubectl_delete', {}, ENV, CONVO, 'a1')).allowed).toBe(true)
    expect(db.toolApprovalRequest.create).not.toHaveBeenCalled()
  })

  it('still respects agent-only restrictions', async () => {
    db.toolAgentRestriction.count.mockResolvedValue(2)
    expect((await checkChatToolPermission('kubectl_get', {}, ENV, CONVO, 'a1')).allowed).toBe(false)
  })
})

describe('evaluateChatToolPolicy / filterToolsForRole', () => {
  it('normalizes unknown roles to readonly (fail closed)', () => {
    expect(normalizeRole('superuser')).toBe('readonly')
    expect(normalizeRole(undefined)).toBe('anonymous')
  })

  it('classifies decisions per role', () => {
    expect(evaluateChatToolPolicy('kubectl_get', 'readonly').decision).toBe('deny')
    expect(evaluateChatToolPolicy('orion_patch_environment', 'user').decision).toBe('deny')
    expect(evaluateChatToolPolicy('kubectl_delete', 'user').decision).toBe('needs_elevation')
    expect(evaluateChatToolPolicy('kubectl_get', 'user').decision).toBe('allow')
    expect(evaluateChatToolPolicy('kubectl_delete', 'admin').decision).toBe('allow')
  })

  it('filters the offered tool list by role', () => {
    const tools = ['kubectl_get', 'kubectl_delete', 'orion_patch_environment', 'orion_archive_agent', 'orion_list_agents']
    expect(filterToolsForRole(tools, 'readonly', t => t)).toEqual([])
    expect(filterToolsForRole(tools, 'anonymous', t => t)).toEqual([])
    // Destructive gateway tools stay visible (env tier / grant can unlock them);
    // admin-only and destructive registry tools are removed.
    expect(filterToolsForRole(tools, 'user', t => t)).toEqual(['kubectl_get', 'kubectl_delete', 'orion_list_agents'])
    expect(filterToolsForRole(tools, 'admin', t => t)).toEqual(tools)
  })
})
