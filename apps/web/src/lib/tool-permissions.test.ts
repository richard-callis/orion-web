/**
 * checkToolPermission — agent tool authorization:
 *   - gateway tools need an active agent + an admin grant (tool group access)
 *     + the tool enabled in the environment policy (+ the agent's allowlist)
 *   - registry tools keep their tier rules
 *   - untrusted (webhook-created) task gate (SOC2 M3)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { db, defs } = vi.hoisted(() => ({
  db: {
    agent: { findUnique: vi.fn() },
    agentEnvironment: { findFirst: vi.fn() },
    mcpTool: { findFirst: vi.fn() },
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

// ── Fixture state: which gateway tools are enabled / granted ──────────────────

let agentRow: { name: string; metadata: unknown } | null
let enabledTools: Record<string, { enabled: boolean; status: string }>
/** tool name → agent ids granted it via a tool group (AgentGroupToolAccess) */
let grantedVia: Record<string, string[]>

beforeEach(() => {
  agentRow = { name: 'Alpha', metadata: {} }
  enabledTools = {
    kubectl_get: { enabled: true, status: 'active' },
    kubectl_delete: { enabled: true, status: 'active' },
    helm_uninstall: { enabled: true, status: 'active' },
    disabled_tool: { enabled: false, status: 'active' },
    pending_tool: { enabled: true, status: 'pending' },
  }
  grantedVia = { kubectl_get: ['agent-1'], kubectl_delete: ['agent-1'], disabled_tool: ['agent-1'], pending_tool: ['agent-1'] }

  db.agent.findUnique.mockReset().mockImplementation(async () => agentRow)
  db.agentEnvironment.findFirst.mockReset().mockResolvedValue({ environmentId: 'env-1' })
  db.mcpTool.findFirst.mockReset().mockImplementation(async ({ where }: { where: { name: string } }) => {
    const t = enabledTools[where.name]
    return t ? { id: `tool:${where.name}`, ...t } : null
  })
  db.toolAgentRestriction.findMany.mockReset().mockResolvedValue([])
  db.toolAgentRestriction.findFirst.mockReset().mockResolvedValue(null)
  db.toolGroupTool.findMany.mockReset().mockResolvedValue([])
  db.toolGroupTool.findFirst.mockReset().mockImplementation(async ({ where }: {
    where: { toolId?: string; toolGroup?: { agentAccess: { some: { agentGroup: { members: { some: { agentId: string } } } } } } }
  }) => {
    if (!where.toolId) return null   // "any group membership across all envs" (no-env branch)
    const name = where.toolId.replace('tool:', '')
    const agentId = where.toolGroup?.agentAccess.some.agentGroup.members.some.agentId
    return agentId && grantedVia[name]?.includes(agentId) ? { toolGroupId: 'tg-1' } : null
  })
  db.agentGroupToolAccess.findFirst.mockReset().mockResolvedValue(null)
  db.task.findUnique.mockReset().mockResolvedValue({ metadata: {} })
  db.task.findFirst.mockReset().mockResolvedValue(null)
  db.toolExecutionGrant.findFirst.mockReset().mockResolvedValue(null)
  db.toolExecutionGrant.update.mockReset().mockResolvedValue({})
  db.toolApprovalRequest.findFirst.mockReset().mockResolvedValue(null)
  db.toolApprovalRequest.create.mockReset().mockResolvedValue({})
})

const check = (tool: string, agent: string | null = 'agent-1', env: string | null = 'env-1', taskId: string | null = 't-1') =>
  checkToolPermission(tool, agent, env, undefined, { taskId })

describe('gateway tools: admin grant rule', () => {
  it('granted + enabled → runs, including destructive tools (the grant is the approval)', async () => {
    expect(await check('kubectl_get')).toEqual({ allowed: true })
    expect(await check('kubectl_delete')).toEqual({ allowed: true })
    expect(db.toolExecutionGrant.findFirst).not.toHaveBeenCalled()
    expect(db.toolApprovalRequest.create).not.toHaveBeenCalled()
  })

  it('the grant is looked up through tool group → agent group membership, in the environment', async () => {
    await check('kubectl_delete')
    expect(db.toolGroupTool.findFirst).toHaveBeenCalledWith({
      where: {
        toolId: 'tool:kubectl_delete',
        toolGroup: { environmentId: 'env-1', agentAccess: { some: { agentGroup: { members: { some: { agentId: 'agent-1' } } } } } },
      },
      select: { toolGroupId: true },
    })
  })

  it('not granted → denied with where to grant it', async () => {
    const res = await check('helm_uninstall')
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('`helm_uninstall` has not been granted to agent "Alpha". An admin can grant it under Admin → Agent Groups (give one of this agent\'s groups access to a tool group that contains it; tool groups are managed under Environments → Tool Groups).')
  })

  it('granted to a different agent only → denied', async () => {
    grantedVia.helm_uninstall = ['agent-2']
    expect((await check('helm_uninstall')).allowed).toBe(false)
  })

  it('revoked (grant removed) → denied', async () => {
    expect((await check('kubectl_delete')).allowed).toBe(true)
    grantedVia.kubectl_delete = []
    expect((await check('kubectl_delete')).allowed).toBe(false)
  })

  it('an agent with no grants at all → every gateway tool denied', async () => {
    grantedVia = {}
    for (const t of ['kubectl_get', 'kubectl_delete', 'helm_uninstall']) expect((await check(t)).allowed).toBe(false)
  })

  it('tool not enabled in the environment policy (disabled, pending or absent) → denied even if granted', async () => {
    for (const t of ['disabled_tool', 'pending_tool', 'not_in_env']) {
      const res = await check(t)
      expect(res.allowed).toBe(false)
      expect(res.reason).toMatch(/is not enabled in this environment's tool policy/)
    }
  })

  it('outside the agent\'s own allowlist (contextConfig.allowedTools) → denied even if granted', async () => {
    agentRow = { name: 'Alpha', metadata: { contextConfig: { allowedTools: ['kubectl_get'] } } }
    expect((await check('kubectl_get')).allowed).toBe(true)
    const res = await check('kubectl_delete')
    expect(res).toEqual({ allowed: false, reason: '`kubectl_delete` is outside agent "Alpha"\'s allowed tool list.' })
  })

  it('archived agent → denied for every tool', async () => {
    agentRow = { name: 'Alpha', metadata: { archived: true } }
    for (const t of ['kubectl_get', 'orion_list_tasks']) {
      expect(await check(t)).toEqual({ allowed: false, reason: 'Agent "Alpha" is archived and may not run tools.' })
    }
  })

  it('unknown agent or no agent → gateway tools denied', async () => {
    agentRow = null
    expect((await check('kubectl_get')).allowed).toBe(false)
    expect((await check('kubectl_get', null)).allowed).toBe(false)
  })

  it('agent not linked to an environment → gateway tools denied', async () => {
    db.agentEnvironment.findFirst.mockResolvedValue(null)
    const res = await check('kubectl_get', 'agent-1', null)
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/not linked to an environment/)
  })

  it('a per-tool agent restriction still applies on top of the grant', async () => {
    db.toolAgentRestriction.findMany.mockResolvedValue([{ agentId: 'agent-9' }])
    const res = await check('kubectl_get')
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/restricted to specific agents/)
  })
})

describe('registry tools (tier rules unchanged)', () => {
  it('read/write allowed without any grant; destructive needs a one-time grant', async () => {
    grantedVia = {}
    expect((await check('orion_list_tasks')).allowed).toBe(true)
    expect((await check('orion_create_task')).allowed).toBe(true)
    const res = await check('orion_archive_agent')
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/destructive tool and requires explicit authorization/)
  })

  it('unknown agent ids (e.g. sub-agents) keep working for registry tools', async () => {
    agentRow = null
    expect((await check('orion_create_task', 'subagent')).allowed).toBe(true)
  })
})

describe('untrusted tasks', () => {
  beforeEach(() => {
    db.task.findUnique.mockResolvedValue({ metadata: { untrusted: true, source: 'webhook' } })
  })

  it('still allows registry read-tier tools without a grant', async () => {
    const res = await check('orion_list_tasks')
    expect(res.allowed).toBe(true)
    expect(db.task.findUnique).not.toHaveBeenCalled()
  })

  it('requires a grant for write-tier registry tools and files an approval request', async () => {
    const res = await check('orion_create_task')
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/untrusted/)
    expect(db.toolApprovalRequest.create).toHaveBeenCalledOnce()
  })

  it('a granted destructive gateway tool still needs one-time approval', async () => {
    const res = await check('kubectl_delete')
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/requires admin approval because this task was created from an external trigger/)
    expect(db.toolApprovalRequest.create).toHaveBeenCalledOnce()
  })

  it('a granted gateway tool runs once an admin approves it for this untrusted run', async () => {
    db.toolExecutionGrant.findFirst.mockResolvedValue({ id: 'grant-1' })
    expect((await check('kubectl_delete')).allowed).toBe(true)
    expect(db.toolExecutionGrant.update).toHaveBeenCalledWith({ where: { id: 'grant-1' }, data: { usedAt: expect.any(Date) } })
  })

  it('an ungranted gateway tool is denied for lack of a grant (before the approval step)', async () => {
    const res = await check('helm_uninstall')
    expect(res.reason).toMatch(/has not been granted/)
    expect(db.toolApprovalRequest.create).not.toHaveBeenCalled()
  })

  it('consumes a one-time grant when an admin approved the tool', async () => {
    db.toolExecutionGrant.findFirst.mockResolvedValue({ id: 'grant-1' })
    expect((await check('orion_create_task')).allowed).toBe(true)
  })

  it('denies when there is no environment context to scope a grant', async () => {
    db.agentEnvironment.findFirst.mockResolvedValue(null)
    expect((await check('orion_create_task', 'agent-1', null)).allowed).toBe(false)
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
    expect((await checkToolPermission('orion_create_task', 'agent-1', null)).allowed).toBe(true)
    expect((await checkToolPermission('kubectl_delete', 'agent-1', null)).allowed).toBe(true)
  })
})
