/**
 * /api/mcp — Claude (sidecar) agents see and call their environment's gateway
 * tools under the same rule as OpenAI/Ollama task agents (checkToolPermission),
 * with arguments validated against the gateway schema.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  checkToolPermission: vi.fn(),
  executeRegisteredTool: vi.fn(async () => 'registry-result'),
  gatewayExecute: vi.fn(async (name: string) => `gw:${name}`),
  agent: { id: 'agent-1', metadata: {} as Record<string, unknown>, mcpToken: 'enc' },
}))

vi.mock('@/lib/db', () => ({ prisma: { agent: { findUnique: vi.fn(async () => h.agent) } } }))
vi.mock('@/lib/encryption', () => ({ decryptStrict: () => 'agent-token' }))
vi.mock('@/lib/management-tools', () => ({}))
vi.mock('@/lib/tool-permissions', () => ({ checkToolPermission: h.checkToolPermission }))
vi.mock('@/lib/tool-registry', () => ({
  getToolsForContext: () => [{ name: 'orion_list_tasks', description: 'list', inputSchema: { type: 'object' } }],
  getToolDefinition: (n: string) => n === 'orion_list_tasks' ? { name: n } : undefined,
  executeRegisteredTool: h.executeRegisteredTool,
}))
vi.mock('@/lib/agent-gateway', () => ({
  resolveAgentGateway: vi.fn(async () => ({
    url: 'http://gw', token: 't', environmentId: 'env-1',
    client: {
      listTools: async () => [
        { name: 'kubectl_delete', description: 'delete', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
        { name: 'orion_list_tasks', description: 'clash', inputSchema: {} },
      ],
      executeTool: h.gatewayExecute,
    },
  })),
}))

import { POST } from './route'

const rpc = (method: string, params?: unknown) => POST(new NextRequest('http://x/api/mcp?agentId=agent-1', {
  method: 'POST',
  headers: { 'x-mcp-token': 'agent-token' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}))
const text = async (res: Response) => (await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }).result

beforeEach(() => {
  h.agent.metadata = {}
  h.checkToolPermission.mockReset().mockResolvedValue({ allowed: true })
  h.gatewayExecute.mockClear()
  h.executeRegisteredTool.mockClear()
})

describe('/api/mcp gateway tools', () => {
  it('tools/list includes the agent environment gateway tools (registry wins on a name clash)', async () => {
    const body = await (await rpc('tools/list')).json() as { result: { tools: Array<{ name: string; description: string }> } }
    expect(body.result.tools.map(t => t.name)).toEqual(['orion_list_tasks', 'kubectl_delete'])
    expect(body.result.tools[0].description).toBe('list')
  })

  it('tools/list honours the agent allowlist', async () => {
    h.agent.metadata = { contextConfig: { allowedTools: ['kubectl_delete'] } }
    const body = await (await rpc('tools/list')).json() as { result: { tools: Array<{ name: string }> } }
    expect(body.result.tools.map(t => t.name)).toEqual(['kubectl_delete'])
  })

  it('granted gateway tool: permission checked in the gateway environment, then executed on the gateway', async () => {
    const r = await text(await rpc('tools/call', { name: 'kubectl_delete', arguments: { name: 'pod-x' } }))
    expect(r).toEqual({ content: [{ type: 'text', text: 'gw:kubectl_delete' }], isError: false })
    expect(h.checkToolPermission).toHaveBeenCalledWith('kubectl_delete', 'agent-1', 'env-1')
    expect(h.gatewayExecute).toHaveBeenCalledWith('kubectl_delete', { name: 'pod-x' })
  })

  it('not granted → error result, nothing executed', async () => {
    h.checkToolPermission.mockResolvedValue({ allowed: false, reason: 'not granted' })
    const r = await text(await rpc('tools/call', { name: 'kubectl_delete', arguments: { name: 'x' } }))
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/not granted/)
    expect(h.gatewayExecute).not.toHaveBeenCalled()
  })

  it('schema errors are reported without executing', async () => {
    const r = await text(await rpc('tools/call', { name: 'kubectl_delete', arguments: {} }))
    expect(r).toEqual({ content: [{ type: 'text', text: 'Tool validation failed for kubectl_delete: field "name" is required. Check the tool schema and retry with correct arguments.' }], isError: true })
    expect(h.gatewayExecute).not.toHaveBeenCalled()
  })

  it('unknown names are rejected before the permission check', async () => {
    const r = await text(await rpc('tools/call', { name: 'nope', arguments: {} }))
    expect(r.isError).toBe(true)
    expect(h.checkToolPermission).not.toHaveBeenCalled()
  })

  it('registry tools still execute through the registry', async () => {
    const r = await text(await rpc('tools/call', { name: 'orion_list_tasks', arguments: {} }))
    expect(r.content[0].text).toBe('registry-result')
    expect(h.gatewayExecute).not.toHaveBeenCalled()
  })
})
