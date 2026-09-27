/**
 * End-to-end: admin-granted gateway tools actually execute for OpenAI/Ollama
 * task agents and OpenAI chat (they used to fail with "Unknown tool"), with
 * the real permission check (tool-permissions.ts) and real argument
 * validation against the gateway's own schema. Only Prisma, the registry and
 * HTTP are faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentEvent, TaskRunContext } from './types'
import type { StreamChunk } from './chat'
import { FakeHttp, json, openaiCompletion, ollamaChat, stream, openaiSSE, collect, collectUntilTerminal, type RecordedCall } from './testing/fake-http'

const h = vi.hoisted(() => {
  const fn = () => ({
    create: vi.fn(async (a: { data: unknown }) => a.data),
    findFirst: vi.fn(async () => null as unknown),
    findUnique: vi.fn(async () => null as unknown),
    findMany: vi.fn(async () => [] as unknown[]),
    count: vi.fn(async () => 0),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
  })
  return {
    prisma: {
      agent: fn(), agentEnvironment: fn(), mcpTool: fn(), toolAgentRestriction: fn(), toolGroupTool: fn(),
      agentGroupToolAccess: fn(), task: fn(), toolExecutionGrant: fn(), toolApprovalRequest: fn(), externalModel: fn(),
      environment: fn(), user: fn(), environmentUserTier: fn(), agentTrace: fn(), message: fn(), claudeInvocation: fn(),
      memory: fn(), systemSetting: fn(),
    },
    state: {
      archived: false,
      granted: new Set<string>(),
      enabled: new Set<string>(),
      untrusted: false,
    },
  }
})

vi.mock('@/lib/db', () => ({ prisma: h.prisma }))
vi.mock('@/lib/system-prompts', () => ({ getPrompt: vi.fn(async () => 'TASK'), interpolate: (t: string) => t }))
vi.mock('@/lib/tool-registry', () => ({
  getToolDefinition: () => undefined,          // every tool in these tests is a gateway tool
  validateToolArgs: () => ({ valid: false, errors: ['registry stub should not be used for gateway tools'] }),
  getAllTools: () => [],
  executeRegisteredTool: vi.fn(),
}))
vi.mock('@/lib/management-tools', () => ({ MANAGEMENT_TOOL_DEFS: [], executeManagedTool: vi.fn() }))
vi.mock('@/lib/embeddings', () => ({
  hybridSearch: vi.fn(), generateEmbedding: vi.fn(), skillVectorSearch: vi.fn(async () => []), ownerFilterWhere: () => ({}),
}))
vi.mock('@/lib/encryption', () => ({ decryptStrict: (v: string) => v }))

import { openaiRunner } from './openai-runner'
import { ollamaRunner } from './ollama-runner'
import { streamOpenAIChat } from '../claude'

const GW_TOOLS = [
  { name: 'kubectl_get', description: 'get', inputSchema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] } },
  { name: 'kubectl_delete', description: 'delete', inputSchema: { type: 'object', properties: { resource: { type: 'string' }, name: { type: 'string' } }, required: ['resource', 'name'] } },
  { name: 'helm_uninstall', description: 'uninstall', inputSchema: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] } },
]

let http: FakeHttp
let executed: RecordedCall[]

beforeEach(() => {
  http = new FakeHttp()
  http.install()
  executed = []
  http.always(/gw\.test\/tools\/execute$/, (call) => { executed.push(call); return new Response(JSON.stringify({ result: `ran ${(call.body as { name: string }).name}` })) })
  http.always(/gw\.test\/tools$/, json(GW_TOOLS))

  h.state.archived = false
  h.state.granted = new Set(['kubectl_get', 'kubectl_delete'])
  h.state.enabled = new Set(['kubectl_get', 'kubectl_delete', 'helm_uninstall'])
  h.state.untrusted = false

  for (const model of Object.values(h.prisma)) for (const f of Object.values(model)) (f as ReturnType<typeof vi.fn>).mockClear()
  h.prisma.agent.findUnique.mockImplementation(async () => ({ name: 'Alpha', metadata: { archived: h.state.archived } }))
  h.prisma.agentEnvironment.findFirst.mockImplementation(async () => ({ environmentId: 'env-1' }))
  h.prisma.mcpTool.findFirst.mockImplementation(async (a: unknown) => {
    const where = (a as { where: { name?: string } }).where
    return where.name && h.state.enabled.has(where.name) ? { id: `tool:${where.name}`, enabled: true, status: 'active', builtIn: true, execType: 'builtin' } : null
  })
  h.prisma.toolGroupTool.findFirst.mockImplementation(async (a: unknown) => {
    const where = (a as { where: { toolId?: string } }).where
    if (!where.toolId) return null
    return h.state.granted.has(where.toolId.replace('tool:', '')) ? { toolGroupId: 'tg' } : null
  })
  h.prisma.task.findUnique.mockImplementation(async () => ({ metadata: h.state.untrusted ? { untrusted: true } : {} }))
  h.prisma.externalModel.findUnique.mockImplementation(async () => ({ id: 'm', provider: 'openai', baseUrl: 'http://llm.test', modelId: 'gpt', apiKey: null, timeoutSecs: 30, maxTokens: null }))
  h.prisma.externalModel.findFirst.mockImplementation(async () => ({ baseUrl: 'http://ollama.test', timeoutSecs: 30 }))
})
afterEach(() => vi.unstubAllGlobals())

const taskCtx = (modelId = 'ext:m'): TaskRunContext => ({
  taskId: 't1', taskTitle: 'clean up', taskDescription: null, taskPlan: null, agentId: 'agent-1', agentName: 'Alpha',
  systemPrompt: 'SYS', modelId, gateway: { url: 'http://gw.test', token: 'gwt' }, environmentId: 'env-1',
})
const results = (events: AgentEvent[]) => events.flatMap(e => e.type === 'tool_result' ? [e.result] : [])

describe('OpenAI task runner — gateway tools', () => {
  it('granted tools run, including destructive kubectl_delete (was "Unknown tool")', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [
        { id: 'a', name: 'kubectl_get', arguments: '{"resource":"pods"}' },
        { id: 'b', name: 'kubectl_delete', arguments: '{"resource":"pod","name":"x"}' },
      ] }),
      openaiCompletion({ content: 'done' }),
    )
    const events = await collect(openaiRunner.run(taskCtx()))
    expect(results(events)).toEqual(['ran kubectl_get', 'ran kubectl_delete'])
    expect(executed.map(c => c.body)).toEqual([
      { name: 'kubectl_get', arguments: { resource: 'pods' } },
      { name: 'kubectl_delete', arguments: { resource: 'pod', name: 'x' } },
    ])
    // Tools were offered to the model with their gateway schemas
    const tools = (http.callsTo('/v1/chat/completions')[0].body as { tools: Array<{ function: { name: string } }> }).tools
    expect(tools.map(t => t.function.name)).toEqual(['kubectl_get', 'kubectl_delete', 'helm_uninstall'])
  })

  it('ungranted tool is denied; nothing reaches the gateway', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'helm_uninstall', arguments: '{"release":"x"}' }] }),
      openaiCompletion({ content: 'ok' }),
    )
    const [r] = results(await collect(openaiRunner.run(taskCtx())))
    expect(r).toMatch(/^Permission denied for tool 'helm_uninstall': `helm_uninstall` has not been granted to agent "Alpha"\. An admin can grant it under Admin → Agent Groups/)
    expect(executed).toHaveLength(0)
  })

  it('archived agent is denied', async () => {
    h.state.archived = true
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'kubectl_get', arguments: '{"resource":"pods"}' }] }),
      openaiCompletion({ content: 'ok' }),
    )
    const [r] = results(await collect(openaiRunner.run(taskCtx())))
    expect(r).toBe("Permission denied for tool 'kubectl_get': Agent \"Alpha\" is archived and may not run tools.. Contact an admin to grant access.")
    expect(executed).toHaveLength(0)
  })

  it('tool not enabled in the environment policy is denied', async () => {
    h.state.enabled.delete('kubectl_get')
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'kubectl_get', arguments: '{"resource":"pods"}' }] }),
      openaiCompletion({ content: 'ok' }),
    )
    expect(results(await collect(openaiRunner.run(taskCtx())))[0]).toMatch(/is not enabled in this environment's tool policy/)
    expect(executed).toHaveLength(0)
  })

  it('arguments are validated against the gateway tool schema', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'kubectl_delete', arguments: '{"resource":5}' }] }),
      openaiCompletion({ content: 'ok' }),
    )
    const [r] = results(await collect(openaiRunner.run(taskCtx())))
    expect(r).toBe('Tool validation failed for kubectl_delete: field "name" is required, field "resource" must be string (got number). Check the tool schema and retry with correct arguments.')
    expect(executed).toHaveLength(0)
  })

  it('a name the gateway does not offer is still rejected as unknown', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'made_up', arguments: '{}' }] }),
      openaiCompletion({ content: 'ok' }),
    )
    expect(results(await collect(openaiRunner.run(taskCtx())))[0]).toBe('Tool validation failed for made_up: Unknown tool: "made_up". Check the tool schema and retry with correct arguments.')
  })

  it('untrusted task: a granted destructive tool still needs approval', async () => {
    h.state.untrusted = true
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'kubectl_delete', arguments: '{"resource":"pod","name":"x"}' }] }),
      openaiCompletion({ content: 'ok' }),
    )
    expect(results(await collect(openaiRunner.run(taskCtx())))[0]).toMatch(/requires admin approval because this task was created from an external trigger/)
    expect(executed).toHaveLength(0)
    expect(h.prisma.toolApprovalRequest.create).toHaveBeenCalledOnce()
  })
})

describe('Ollama task runner — gateway tools', () => {
  it('granted destructive tool runs; ungranted denied', async () => {
    http.route('/api/chat',
      ollamaChat({ tool_calls: [
        { name: 'kubectl_delete', arguments: { resource: 'pod', name: 'x' } },
        { name: 'helm_uninstall', arguments: { release: 'r' } },
      ] }),
      ollamaChat({ content: 'done' }),
    )
    const r = results(await collect(ollamaRunner.run(taskCtx('ollama:llama3'))))
    expect(r[0]).toBe('ran kubectl_delete')
    expect(r[1]).toMatch(/has not been granted to agent "Alpha"/)
    expect(executed.map(c => (c.body as { name: string }).name)).toEqual(['kubectl_delete'])
  })
})

describe('OpenAI chat — gateway tools (human chat rules unchanged)', () => {
  beforeEach(() => {
    h.prisma.environment.findFirst.mockImplementation(async () => ({ id: 'env-1', gatewayUrl: 'http://gw.test', gatewayToken: 'gwt', status: 'connected' }))
  })

  it('admin user: gateway tool validates against its schema and runs (was "Unknown tool")', async () => {
    h.prisma.user.findUnique.mockImplementation(async () => ({ role: 'admin', active: true }))
    http.route('/chat/completions',
      stream(openaiSSE([{ tool_calls: [{ index: 0, id: 'a', function: { name: 'kubectl_get', arguments: '{"resource":"pods"}' } }] }])),
      stream(openaiSSE([{ content: 'three pods' }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('pods?', 'c1', [], 'gpt', 'http://oai.test/v1', undefined, undefined, 'u-admin'))
    expect(chunks.slice(0, 2)).toEqual<StreamChunk[]>([
      { type: 'tool_call', tool: 'kubectl_get', input: '{"resource":"pods"}' },
      { type: 'tool_result', tool: 'kubectl_get', output: 'ran kubectl_get' },
    ])
  })

  it('gateway schema errors are reported in chat too', async () => {
    h.prisma.user.findUnique.mockImplementation(async () => ({ role: 'admin', active: true }))
    http.route('/chat/completions',
      stream(openaiSSE([{ tool_calls: [{ index: 0, id: 'a', function: { name: 'kubectl_get', arguments: '{}' } }] }])),
      stream(openaiSSE([{ content: 'k' }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('x', 'c1', [], 'gpt', 'http://oai.test/v1', undefined, undefined, 'u-admin'))
    expect(chunks[1]).toEqual({ type: 'tool_result', tool: 'kubectl_get', output: 'Tool validation failed for kubectl_get: field "resource" is required. Check the tool schema and retry with correct arguments.' })
    expect(executed).toHaveLength(0)
  })

  it('readonly human user is still denied (and offered no tools)', async () => {
    h.prisma.user.findUnique.mockImplementation(async () => ({ role: 'readonly', active: true }))
    http.route('/chat/completions',
      stream(openaiSSE([{ tool_calls: [{ index: 0, id: 'a', function: { name: 'kubectl_get', arguments: '{"resource":"pods"}' } }] }])),
      stream(openaiSSE([{ content: 'k' }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('x', 'c1', [], 'gpt', 'http://oai.test/v1', undefined, undefined, 'u-ro'))
    expect((http.callsTo('/chat/completions')[0].body as Record<string, unknown>).tools).toBeUndefined()
    // readonly users never get a gateway connection, so the name isn't even known here
    expect(chunks[1]).toEqual({ type: 'tool_result', tool: 'kubectl_get', output: 'Tool validation failed for kubectl_get: Unknown tool: "kubectl_get". Check the tool schema and retry with correct arguments.' })
    expect(http.callsTo('gw.test')).toHaveLength(0)
    expect(executed).toHaveLength(0)
  })
})
