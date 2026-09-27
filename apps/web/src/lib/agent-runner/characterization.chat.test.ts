/**
 * Characterization tests for the human-chat entry points in lib/claude.ts
 * (the functions the /api/chat/conversations/:id/stream SSE route calls).
 *
 * They pin the StreamChunk sequences the UI consumes (ChatWindow,
 * TeamDetailPanel) byte-for-byte, the persistence side effects, and the
 * phase-1 security behaviour (readonly → no tools, admin-only and destructive
 * tools gated, one-time grants consumed once). The real chat-tool-policy
 * module runs against a mocked Prisma so the gate itself is exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamChunk } from '../claude'
import {
  FakeHttp, json, text, stream, openaiSSE, ollamaChat, ollamaNDJSON, geminiSSE, sidecarNDJSON, collectUntilTerminal,
} from './testing/fake-http'

const h = vi.hoisted(() => {
  const fn = () => ({
    create: vi.fn(async (a: { data: unknown }) => a.data),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
  })
  const registry: Record<string, { tier: 'read' | 'write' | 'destructive'; availableIn: string }> = {
    orion_list_tasks: { tier: 'read', availableIn: 'both' },
    orion_patch_environment: { tier: 'destructive', availableIn: 'chat' },
    orion_archive_agent: { tier: 'destructive', availableIn: 'both' },
    strict_tool: { tier: 'read', availableIn: 'both' },
  }
  return {
    prisma: {
      agentTrace: fn(), message: fn(), claudeInvocation: fn(), environment: fn(), externalModel: fn(),
      memory: fn(), task: fn(), conversation: fn(), systemSetting: fn(), user: fn(), toolAgentRestriction: fn(),
      mcpTool: fn(), environmentUserTier: fn(), toolGroupTool: fn(), toolExecutionGrant: fn(), toolApprovalRequest: fn(),
    },
    registry,
    executeRegisteredTool: vi.fn(async (name: string) => `registry:${name}`),
    validateToolArgs: vi.fn((name: string) => name === 'strict_tool'
      ? { valid: false, errors: ['id is required'] }
      : { valid: true, errors: [] }),
    getRunTokenCap: vi.fn(async () => 400_000),
    beginBudgetedRun: vi.fn(),
    finish: vi.fn(async () => {}),
  }
})

vi.mock('@/lib/db', () => ({ prisma: h.prisma }))
vi.mock('@/lib/system-prompts', () => ({
  getPrompt: vi.fn(async (key: string) => `[${key}]`),
  interpolate: (t: string) => t,
}))
vi.mock('@/lib/embeddings', () => ({
  hybridSearch: vi.fn(async () => ({ hits: [] })),
  generateEmbedding: vi.fn(async () => null),
  skillVectorSearch: vi.fn(async () => []),
  ownerFilterWhere: () => ({}),
}))
vi.mock('@/lib/tool-registry', () => ({
  getToolDefinition: (name: string) => h.registry[name] ? { name, ...h.registry[name] } : undefined,
  getAllTools: () => Object.entries(h.registry).map(([name, d]) => ({ name, description: `desc ${name}`, inputSchema: { type: 'object' }, ...d })),
  validateToolArgs: h.validateToolArgs,
  executeRegisteredTool: h.executeRegisteredTool,
}))
vi.mock('@/lib/management-tools', () => ({
  MANAGEMENT_TOOL_DEFS: Object.keys(h.registry).map(name => ({ name, description: `desc ${name}`, inputSchema: { type: 'object' } })),
  executeManagedTool: (name: string, argsRaw: string, actorId?: string, userId?: string) =>
    h.executeRegisteredTool(name, JSON.parse(argsRaw || '{}'), { agentId: actorId, userId }),
}))
vi.mock('@/lib/llm-budget', async (orig) => ({
  ...(await orig<typeof import('../llm-budget')>()),
  getRunTokenCap: h.getRunTokenCap,
  beginBudgetedRun: h.beginBudgetedRun,
}))

import { streamOpenAIChat, streamOllamaChat, streamGeminiChat, streamClaudeResponse, streamAgentChat } from '../claude'

let http: FakeHttp
const OAI = 'http://oai.test/v1'

function asRole(role: 'admin' | 'user' | 'readonly') {
  h.prisma.user.findUnique.mockResolvedValue({ role, active: true } as never)
}
function withGateway(tools: string[]) {
  h.prisma.environment.findFirst.mockResolvedValue({ id: 'env-1', gatewayUrl: 'http://gw.test', gatewayToken: 'gwt', status: 'connected' } as never)
  http.route('http://gw.test/tools/execute', json({ result: 'gw-result' }))
  http.always(/http:\/\/gw\.test\/tools$/, json(tools.map(name => ({ name, description: `gw ${name}`, inputSchema: { type: 'object' } }))))
}
const saved = () => h.prisma.message.create.mock.calls.map(c => (c[0] as { data: Record<string, unknown> }).data)

beforeEach(() => {
  http = new FakeHttp()
  http.install()
  for (const model of Object.values(h.prisma)) for (const f of Object.values(model)) (f as ReturnType<typeof vi.fn>).mockClear()
  h.prisma.environment.findFirst.mockResolvedValue(null as never)
  h.prisma.externalModel.findFirst.mockResolvedValue({ baseUrl: 'http://ollama.test', timeoutSecs: 30 } as never)
  asRole('user')
  h.executeRegisteredTool.mockClear()
  h.getRunTokenCap.mockResolvedValue(400_000)
  h.beginBudgetedRun.mockReset().mockResolvedValue({ allowed: true, finish: h.finish })
  h.finish.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

// ── OpenAI-compatible chat (streaming SSE) ───────────────────────────────────

describe('streamOpenAIChat', () => {
  it('streams text deltas, persists, then done', async () => {
    http.route('/chat/completions', stream(openaiSSE([{ content: 'Hel' }, { content: 'lo' }])))
    const chunks = await collectUntilTerminal(streamOpenAIChat('hi', 'c1', [{ role: 'assistant', content: 'prev' }], 'gpt', OAI, 'key', undefined, 'u1'))
    expect(chunks).toEqual<StreamChunk[]>([
      { type: 'text', content: 'Hel' },
      { type: 'text', content: 'lo' },
      { type: 'done' },
    ])
    const [call] = http.callsTo('/chat/completions')
    expect(call.url).toBe('http://oai.test/v1/chat/completions')
    expect(call.headers.authorization).toBe('Bearer key')
    const body = call.body as { stream: boolean; messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }
    expect(body.stream).toBe(true)
    expect(body.messages.slice(1)).toEqual([{ role: 'assistant', content: 'prev' }, { role: 'user', content: 'hi' }])
    // Non-admin: admin-only and destructive registry tools are never offered
    const offered = body.tools.map(t => t.function.name)
    expect(offered).toContain('orion_list_tasks')
    expect(offered).not.toContain('orion_patch_environment')
    expect(offered).not.toContain('orion_archive_agent')
    expect(saved()).toEqual([
      { conversationId: 'c1', role: 'user', content: 'hi' },
      { conversationId: 'c1', role: 'assistant', content: 'Hello', metadata: undefined },
    ])
  })

  it('tool call (fragmented args) → registry tool → next turn text; tool log persisted', async () => {
    http.route('/chat/completions',
      stream(openaiSSE([
        { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'orion_list_tasks', arguments: '{"sta' } }] },
        { tool_calls: [{ index: 0, function: { arguments: 'tus":"open"}' } }] },
      ])),
      stream(openaiSSE([{ content: 'Two tasks.' }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('tasks?', 'c1', [], 'gpt', OAI, undefined, undefined, 'u1'))
    expect(chunks).toEqual<StreamChunk[]>([
      { type: 'tool_call', tool: 'orion_list_tasks', input: '{"status":"open"}' },
      { type: 'tool_result', tool: 'orion_list_tasks', output: 'registry:orion_list_tasks' },
      { type: 'text', content: 'Two tasks.' },
      { type: 'done' },
    ])
    expect(h.executeRegisteredTool).toHaveBeenCalledWith('orion_list_tasks', { status: 'open' }, expect.objectContaining({ userId: 'u1' }))
    const second = http.callsTo('/chat/completions')[1].body as { messages: unknown[] }
    expect(second.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'orion_list_tasks', arguments: '{"status":"open"}' } }] },
      { role: 'tool', content: 'registry:orion_list_tasks', tool_call_id: 'call_1' },
    ])
    expect(saved()[1]).toEqual({
      conversationId: 'c1', role: 'assistant', content: 'Two tasks.',
      metadata: { toolCalls: [{ tool: 'orion_list_tasks', input: '{"status":"open"}', output: 'registry:orion_list_tasks' }] },
    })
  })

  it('admin-only tool called by a regular user is denied; validation failure reported', async () => {
    http.route('/chat/completions',
      stream(openaiSSE([
        { tool_calls: [{ index: 0, id: 'a', function: { name: 'orion_patch_environment', arguments: '{}' } }] },
        { tool_calls: [{ index: 1, id: 'b', function: { name: 'strict_tool', arguments: '{}' } }] },
      ])),
      stream(openaiSSE([{ content: 'ok' }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('x', 'c1', [], 'gpt', OAI, undefined, undefined, 'u1'))
    expect(chunks).toEqual<StreamChunk[]>([
      { type: 'tool_call', tool: 'orion_patch_environment', input: '{}' },
      { type: 'tool_result', tool: 'orion_patch_environment', output: 'Permission denied: `orion_patch_environment` is restricted to administrators.' },
      { type: 'tool_call', tool: 'strict_tool', input: '{}' },
      { type: 'tool_result', tool: 'strict_tool', output: 'Tool validation failed for strict_tool: id is required. Check the tool schema and retry with correct arguments.' },
      { type: 'text', content: 'ok' },
      { type: 'done' },
    ])
    expect(h.executeRegisteredTool).not.toHaveBeenCalled()
  })

  it('readonly user: no tools offered, any tool call denied', async () => {
    asRole('readonly')
    http.route('/chat/completions',
      stream(openaiSSE([{ tool_calls: [{ index: 0, id: 'a', function: { name: 'orion_list_tasks', arguments: '{}' } }] }])),
      stream(openaiSSE([{ content: 'sorry' }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('x', 'c1', [], 'gpt', OAI, undefined, undefined, 'u2'))
    expect((http.callsTo('/chat/completions')[0].body as Record<string, unknown>).tools).toBeUndefined()
    expect(chunks[1]).toEqual({ type: 'tool_result', tool: 'orion_list_tasks', output: 'Permission denied: Your account is not permitted to run tools from chat.' })
    expect(h.executeRegisteredTool).not.toHaveBeenCalled()
  })

  it('destructive gateway tool for a user without tier: approval request filed, denied', async () => {
    withGateway(['kubectl_get', 'kubectl_delete'])
    http.route('/chat/completions',
      stream(openaiSSE([
        { tool_calls: [{ index: 0, id: 'a', function: { name: 'kubectl_get', arguments: '{"r":"pods"}' } }] },
        { tool_calls: [{ index: 1, id: 'b', function: { name: 'kubectl_delete', arguments: '{"r":"pod/x"}' } }] },
      ])),
      stream(openaiSSE([{ content: 'done' }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('x', 'c1', [], 'gpt', OAI, undefined, undefined, 'u1'))
    expect(chunks.slice(0, 4)).toEqual<StreamChunk[]>([
      { type: 'tool_call', tool: 'kubectl_get', input: '{"r":"pods"}' },
      { type: 'tool_result', tool: 'kubectl_get', output: 'gw-result' },
      { type: 'tool_call', tool: 'kubectl_delete', input: '{"r":"pod/x"}' },
      { type: 'tool_result', tool: 'kubectl_delete', output: 'Permission denied: `kubectl_delete` requires **admin** access in this environment. An approval request has been submitted — an administrator can approve it, after which you can retry.' },
    ])
    expect(http.callsTo('/tools/execute')).toHaveLength(1)
    expect(http.callsTo('/tools/execute')[0].headers['x-orion-actor-id']).toBe('u1')
    expect(h.prisma.toolApprovalRequest.create).toHaveBeenCalledTimes(1)
  })

  it('a one-time grant is consumed exactly once per call', async () => {
    withGateway(['kubectl_delete'])
    h.prisma.toolExecutionGrant.findFirst.mockResolvedValueOnce({ id: 'g1' } as never)
    http.route('/chat/completions',
      stream(openaiSSE([{ tool_calls: [{ index: 0, id: 'a', function: { name: 'kubectl_delete', arguments: '{}' } }] }])),
      stream(openaiSSE([{ content: 'deleted' }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('x', 'c1', [], 'gpt', OAI, undefined, undefined, 'u1'))
    expect(chunks[1]).toEqual({ type: 'tool_result', tool: 'kubectl_delete', output: 'gw-result' })
    expect(h.prisma.toolExecutionGrant.updateMany).toHaveBeenCalledTimes(1)
  })

  it('per-run token cap stops the loop with a visible message', async () => {
    h.getRunTokenCap.mockResolvedValue(5)
    http.route('/chat/completions',
      stream(openaiSSE([{ tool_calls: [{ index: 0, id: 'a', function: { name: 'orion_list_tasks', arguments: '{}' } }] }])),
    )
    const chunks = await collectUntilTerminal(streamOpenAIChat('x', 'c1', [], 'gpt', OAI, undefined, undefined, 'u1'))
    expect(chunks.map(c => c.type)).toEqual(['tool_call', 'tool_result', 'text', 'done'])
    expect(chunks[2].content).toMatch(/^Stopped: this run reached its token cap \(\d[\d,]* \/ 5 tokens\)/)
    expect(http.callsTo('/chat/completions')).toHaveLength(1)
  })

  it('provider error → prefixed error chunk', async () => {
    http.route('/chat/completions', text('boom', 500))
    expect(await collectUntilTerminal(streamOpenAIChat('x', 'c1', [], 'gpt', OAI))).toEqual([
      { type: 'error', error: 'OpenAI API error: OpenAI-compatible API 500: boom' },
    ])
  })
})

// ── Ollama chat ──────────────────────────────────────────────────────────────

describe('streamOllamaChat', () => {
  it('no gateway: streams NDJSON text, then done', async () => {
    http.route('/api/chat', stream(ollamaNDJSON(['Hi', ' there'])))
    const chunks = await collectUntilTerminal(streamOllamaChat('hey', 'c1', [], 'llama3', undefined, undefined, 'u1'))
    expect(chunks).toEqual<StreamChunk[]>([{ type: 'text', content: 'Hi' }, { type: 'text', content: ' there' }, { type: 'done' }])
    const body = http.callsTo('/api/chat')[0].body as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.tools).toBeUndefined()
    expect(saved().map(d => d.content)).toEqual(['hey', 'Hi there'])
  })

  it('with gateway: tool loop, gateway tool executed, final text', async () => {
    withGateway(['kubectl_get'])
    http.route('/api/chat',
      ollamaChat({ content: 'thinking', tool_calls: [{ name: 'kubectl_get', arguments: { r: 'pods' } }] }),
      ollamaChat({ content: '3 pods' }),
    )
    const chunks = await collectUntilTerminal(streamOllamaChat('pods?', 'c1', [], 'llama3', undefined, undefined, 'u1'))
    expect(chunks).toEqual<StreamChunk[]>([
      { type: 'tool_call', tool: 'kubectl_get', input: '{"r":"pods"}' },
      { type: 'tool_result', tool: 'kubectl_get', output: 'gw-result' },
      { type: 'text', content: '3 pods' },
      { type: 'done' },
    ])
    const body = http.callsTo('/api/chat')[0].body as { stream: boolean; tools: Array<{ function: { name: string } }> }
    expect(body.stream).toBe(false)
    expect(body.tools.map(t => t.function.name)).toEqual(expect.arrayContaining(['kubectl_get', 'knowledge_search', 'knowledge_graph', 'propose_tool']))
    expect(saved().map(d => d.content)).toEqual(['pods?', '3 pods'])
  })

  it('readonly user with a connected gateway: no tools at all (plain stream)', async () => {
    asRole('readonly')
    withGateway(['kubectl_get'])
    http.route('/api/chat', stream(ollamaNDJSON(['ok'])))
    await collectUntilTerminal(streamOllamaChat('x', 'c1', [], 'llama3', undefined, undefined, 'u2'))
    expect((http.callsTo('/api/chat')[0].body as Record<string, unknown>).tools).toBeUndefined()
    expect(http.callsTo('gw.test')).toHaveLength(0)
  })

  it('destructive gateway tool for a regular user is denied', async () => {
    withGateway(['kubectl_delete'])
    http.route('/api/chat',
      ollamaChat({ tool_calls: [{ name: 'kubectl_delete', arguments: { r: 'x' } }] }),
      ollamaChat({ content: 'k' }),
    )
    const chunks = await collectUntilTerminal(streamOllamaChat('x', 'c1', [], 'llama3', undefined, undefined, 'u1'))
    expect(chunks[1].type).toBe('tool_result')
    expect(chunks[1].output).toMatch(/^Permission denied: `kubectl_delete` requires \*\*admin\*\* access/)
    expect(http.callsTo('/tools/execute')).toHaveLength(0)
  })

  it('HTTP error → Ollama error chunk', async () => {
    withGateway(['kubectl_get'])
    http.route('/api/chat', text('down', 500))
    expect(await collectUntilTerminal(streamOllamaChat('x', 'c1', [], 'llama3', undefined, undefined, 'u1'))).toEqual([
      { type: 'error', error: 'Ollama error: Ollama 500: down' },
    ])
  })
})

// ── Gemini chat ──────────────────────────────────────────────────────────────

describe('streamGeminiChat', () => {
  it('streams text; key in header; history mapped to model role', async () => {
    process.env.GEMINI_API_KEY = 'gk'
    http.route('generativelanguage.googleapis.com', stream(geminiSSE(['A', 'B'])))
    const chunks = await collectUntilTerminal(streamGeminiChat('q', 'c1', [{ role: 'assistant', content: 'prev' }], 'gemini-2.0-flash'))
    expect(chunks).toEqual<StreamChunk[]>([{ type: 'text', content: 'A' }, { type: 'text', content: 'B' }, { type: 'done' }])
    const [call] = http.callsTo('generativelanguage')
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse')
    expect(call.headers['x-goog-api-key']).toBe('gk')
    expect((call.body as { contents: unknown[] }).contents).toEqual([
      { role: 'model', parts: [{ text: 'prev' }] },
      { role: 'user', parts: [{ text: 'q' }] },
    ])
  })

  it('missing key → error chunk', async () => {
    delete process.env.GEMINI_API_KEY
    expect(await collectUntilTerminal(streamGeminiChat('q', 'c1', [], 'g'))).toEqual([
      { type: 'error', error: 'Gemini API key not configured — add GEMINI_API_KEY to Vault secret/orion' },
    ])
  })
})

// ── Claude sidecar chat ─────────────────────────────────────────────────────

describe('streamClaudeResponse', () => {
  it('maps sidecar NDJSON events to chunks and persists the tool log', async () => {
    http.route('/run', stream(sidecarNDJSON([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'kubectl get pods' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'pod-a' }] }] } },
      { type: 'result', subtype: 'success', result: 'One pod.' },
    ])))
    const chunks = await collectUntilTerminal(streamClaudeResponse('pods?', 'c1', [{ role: 'user', content: 'earlier' }]))
    expect(chunks).toEqual<StreamChunk[]>([
      { type: 'text', content: 'Checking.' },
      { type: 'tool_call', tool: 'Bash', input: '{"command":"kubectl get pods"}' },
      { type: 'tool_result', output: 'pod-a' },
      { type: 'text', content: 'One pod.' },
      { type: 'done' },
    ])
    const body = http.callsTo('/run')[0].body as Record<string, unknown>
    expect(body.prompt).toBe('user: earlier\n\nuser: pods?')
    expect(body.allowedTools).toEqual(['Bash(kubectl get:*)', 'Bash(kubectl describe:*)', 'Bash(kubectl logs:*)', 'Bash(kubectl top:*)'])
    expect(body.maxTurns).toBe(20)
    expect(body.model).toBeUndefined()
    expect(saved()[1]).toEqual({
      conversationId: 'c1', role: 'assistant', content: 'Checking.\n\nOne pod.',
      metadata: { toolCalls: [{ tool: 'Bash', input: '{"command":"kubectl get pods"}', output: 'pod-a' }] },
    })
  })

  it('readonly override: allowedTools [] is forwarded', async () => {
    http.route('/run', stream(sidecarNDJSON([{ type: 'result', subtype: 'success', result: 'hi' }])))
    await collectUntilTerminal(streamClaudeResponse('x', 'c1', [], null, undefined, { allowedTools: [] }))
    expect((http.callsTo('/run')[0].body as Record<string, unknown>).allowedTools).toEqual([])
  })

  it('sidecar error line → error chunk', async () => {
    http.route('/run', stream(sidecarNDJSON([{ type: 'error', error: 'not logged in' }])))
    expect(await collectUntilTerminal(streamClaudeResponse('x', 'c1'))).toEqual([{ type: 'error', error: 'not logged in' }])
  })

  it('planning: Opus review appended after the draft', async () => {
    http.route('/run/collect', json({ text: 'FINAL PLAN' }))
    http.route(/\/run$/, stream(sidecarNDJSON([{ type: 'result', subtype: 'success', result: 'draft' }])))
    const chunks = await collectUntilTerminal(streamClaudeResponse('plan it', 'c1', [], { type: 'epic', id: 'e1' }))
    expect(chunks).toEqual<StreamChunk[]>([
      { type: 'text', content: 'draft' },
      { type: 'text', content: '\n\n---\n\n*Reviewing with Opus...*\n\n' },
      { type: 'text', content: 'FINAL PLAN' },
      { type: 'done' },
    ])
    expect((http.callsTo('/run/collect')[0].body as Record<string, unknown>).maxTurns).toBe(1)
  })
})

// ── Agent chat (budget + provider routing) ───────────────────────────────────

describe('streamAgentChat', () => {
  it('over budget → error, no provider call', async () => {
    h.beginBudgetedRun.mockResolvedValue({ allowed: false, reason: 'daily budget exhausted' })
    expect(await collectUntilTerminal(streamAgentChat('x', 'c1', 'You are Bob.', [], { llm: 'ext:m' }, 'agent-1'))).toEqual([
      { type: 'error', error: 'This agent is over its token budget: daily budget exhausted' },
    ])
    expect(http.calls).toHaveLength(0)
  })

  it('ext:<openai> agent: persona prompt, streamed reply, budget recorded', async () => {
    h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'm', provider: 'openai', modelId: 'gpt', baseUrl: OAI, apiKey: null, timeoutSecs: 60 } as never)
    http.route('/chat/completions', stream(openaiSSE([{ content: 'Bob here.' }])))
    const chunks = await collectUntilTerminal(streamAgentChat('hi', 'c1', 'You are Bob.', [], { llm: 'ext:m' }, 'agent-1', 'u1'))
    expect(chunks).toEqual<StreamChunk[]>([{ type: 'text', content: 'Bob here.' }, { type: 'done' }])
    const sys = (http.callsTo('/chat/completions')[0].body as { messages: Array<{ content: string }> }).messages[0].content
    expect(sys.startsWith('You are Bob.')).toBe(true)
    expect(sys).toContain('No MCP gateway is connected right now.')
    expect(h.finish).toHaveBeenCalledTimes(1)
  })

  it('claude agent: persona override prompt sent to the sidecar with agent maxTurns', async () => {
    http.route('/run', stream(sidecarNDJSON([{ type: 'result', subtype: 'success', result: 'yo' }])))
    const chunks = await collectUntilTerminal(streamAgentChat('hi', 'c1', 'You are Bob.', [], { llm: 'claude:claude-x', maxTurns: 3 }, 'agent-1', 'u1'))
    expect(chunks).toEqual<StreamChunk[]>([{ type: 'text', content: 'yo' }, { type: 'done' }])
    const body = http.callsTo('/run')[0].body as Record<string, unknown>
    expect(body.systemPrompt).toContain('You are NOT Claude Code')
    expect(body.systemPrompt).toContain('You are Bob.')
    expect(body.maxTurns).toBe(3)
    expect(body.allowedTools).toEqual([])
    expect(body.model).toBe('claude-x')
  })
})
