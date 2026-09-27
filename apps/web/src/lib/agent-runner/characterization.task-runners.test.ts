/**
 * Characterization tests for the task runners (worker entry points).
 *
 * Written against the pre-consolidation runners and kept green through the
 * move to the shared engine: they pin the exact AgentEvent sequences, request
 * shapes and denial/validation texts the worker depends on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentEvent, TaskRunContext } from './types'
import { FakeHttp, json, text, openaiCompletion, ollamaChat, collect } from './testing/fake-http'

const h = vi.hoisted(() => ({
  checkToolPermission: vi.fn(),
  validateToolArgs: vi.fn(),
  prisma: {
    externalModel: { findUnique: vi.fn(), findFirst: vi.fn() },
    agent: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/system-prompts', () => ({
  getPrompt: vi.fn(async () => 'TASK {{taskTitle}}{{taskDescription}}{{taskPlan}}'),
  interpolate: (t: string, v: Record<string, string>) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? ''),
}))
vi.mock('@/lib/tool-registry', () => ({ validateToolArgs: h.validateToolArgs }))
vi.mock('@/lib/tool-permissions', () => ({ checkToolPermission: h.checkToolPermission }))
vi.mock('@/lib/db', () => ({ prisma: h.prisma }))
vi.mock('@/lib/encryption', () => ({ decryptStrict: (v: string) => `dec(${v})` }))

import { openaiRunner } from './openai-runner'
import { ollamaRunner } from './ollama-runner'
import { claudeRunner } from './claude-runner'

let http: FakeHttp

function ctx(overrides: Partial<TaskRunContext> = {}): TaskRunContext {
  return {
    taskId: 't1', taskTitle: 'Fix it', taskDescription: 'desc', taskPlan: null,
    agentId: 'agent-1', agentName: 'Alpha', systemPrompt: 'SYS', modelId: 'ext:m1', gateway: null,
    ...overrides,
  }
}

function mgmt(executed: string[] = []) {
  return {
    definitions: [
      { name: 'orion_list_tasks', description: 'list tasks', inputSchema: { type: 'object' } },
      { name: 'orion_update_task', description: 'update', inputSchema: { type: 'object' } },
    ],
    execute: vi.fn(async (name: string, argsRaw: string) => { executed.push(`${name}:${argsRaw}`); return `ran ${name}` }),
  }
}

beforeEach(() => {
  http = new FakeHttp()
  http.install()
  h.checkToolPermission.mockReset().mockResolvedValue({ allowed: true })
  h.validateToolArgs.mockReset().mockReturnValue({ valid: true, errors: [] })
  h.prisma.externalModel.findUnique.mockReset().mockResolvedValue({
    id: 'm1', provider: 'openai', baseUrl: 'http://llm.test', modelId: 'gpt-x', apiKey: 'k', timeoutSecs: 30, maxTokens: null,
  })
  h.prisma.externalModel.findFirst.mockReset().mockResolvedValue({ baseUrl: 'http://ollama.test', timeoutSecs: 30 })
  h.prisma.agent.findUnique.mockReset().mockResolvedValue({ mcpToken: 'enc-token' })
})
afterEach(() => vi.unstubAllGlobals())

// ── OpenAI-compatible task runner ─────────────────────────────────────────────

describe('openaiRunner', () => {
  it('text-only run: text, aggregated usage, done; request shape', async () => {
    http.route('/v1/chat/completions', openaiCompletion({ content: 'All done.' }, { prompt_tokens: 10, completion_tokens: 4 }))
    const events = await collect(openaiRunner.run(ctx()))
    expect(events).toEqual<AgentEvent[]>([
      { type: 'text', content: 'All done.' },
      { type: 'usage', inputTokens: 10, outputTokens: 4 },
      { type: 'done' },
    ])
    const [call] = http.callsTo('/v1/chat/completions')
    expect(call.url).toBe('http://llm.test/v1/chat/completions')
    expect(call.headers.authorization).toBe('Bearer k')
    expect(call.body).toEqual({
      model: 'gpt-x',
      stream: false,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'TASK Fix itDescription: desc' },
      ],
    })
  })

  it('tool call → result → final text; usage summed over turns', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ content: '', tool_calls: [{ id: 'c1', name: 'orion_update_task', arguments: '{"id":"x"}' }] }, { prompt_tokens: 5, completion_tokens: 1 }),
      openaiCompletion({ content: 'Updated.' }, { prompt_tokens: 7, completion_tokens: 2 }),
    )
    const executed: string[] = []
    const events = await collect(openaiRunner.run(ctx({ managementTools: mgmt(executed) })))
    expect(events).toEqual<AgentEvent[]>([
      { type: 'tool_call', tool: 'orion_update_task', args: '{"id":"x"}' },
      { type: 'tool_result', tool: 'orion_update_task', result: 'ran orion_update_task' },
      { type: 'text', content: 'Updated.' },
      { type: 'usage', inputTokens: 12, outputTokens: 3 },
      { type: 'done' },
    ])
    expect(executed).toEqual(['orion_update_task:{"id":"x"}'])
    const second = http.callsTo('/v1/chat/completions')[1].body as { messages: unknown[]; tools: unknown[] }
    expect(second.messages.slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'orion_update_task', arguments: '{"id":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ran orion_update_task' },
    ])
    expect(second.tools).toEqual([
      { type: 'function', function: { name: 'orion_list_tasks', description: 'list tasks', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'orion_update_task', description: 'update', parameters: { type: 'object' } } },
    ])
    expect(h.checkToolPermission).toHaveBeenCalledWith('orion_update_task', 'agent-1', null, undefined, { taskId: 't1' })
  })

  it('permission denial and validation failure texts', async () => {
    h.checkToolPermission.mockResolvedValueOnce({ allowed: false, reason: 'nope' })
    h.validateToolArgs.mockImplementation((name: string) =>
      name === 'orion_list_tasks' ? { valid: false, errors: ['limit must be a number'] } : { valid: true, errors: [] })
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [
        { id: 'a', name: 'orion_update_task', arguments: '{}' },
        { id: 'b', name: 'orion_list_tasks', arguments: '{"limit":"x"}' },
      ] }),
      openaiCompletion({ content: 'ok' }),
    )
    const events = await collect(openaiRunner.run(ctx({ managementTools: mgmt() })))
    // orion_list_tasks is parallel-safe: announced + resolved first, then sequential calls
    expect(events).toEqual<AgentEvent[]>([
      { type: 'tool_call', tool: 'orion_list_tasks', args: '{"limit":"x"}' },
      { type: 'tool_result', tool: 'orion_list_tasks', result: 'Tool validation failed for orion_list_tasks: limit must be a number. Check the tool schema and retry with correct arguments.' },
      { type: 'tool_call', tool: 'orion_update_task', args: '{}' },
      { type: 'tool_result', tool: 'orion_update_task', result: "Permission denied for tool 'orion_update_task': nope. Contact an admin to grant access." },
      { type: 'text', content: 'ok' },
      { type: 'done' },
    ])
  })

  it('replays a checkpointed step instead of executing it', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'orion_update_task', arguments: '{}' }] }),
      openaiCompletion({ content: 'fin' }),
    )
    const m = mgmt()
    const events = await collect(openaiRunner.run(ctx({
      managementTools: m,
      checkpoints: new Map([[1, { toolName: 'orion_update_task', result: 'stored' }]]),
    })))
    expect(events[1]).toEqual({ type: 'tool_result', tool: 'orion_update_task', result: '[Replayed from checkpoint step 1]\nstored' })
    expect(m.execute).not.toHaveBeenCalled()
  })

  it('gateway tools: listed, executed with agent actor headers', async () => {
    http.route('http://gw.test/tools/execute', json({ result: 'pods: 3' }))
    http.route('http://gw.test/tools', json([{ name: 'kubectl_get', description: 'get', inputSchema: { type: 'object' } }]))
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'g', name: 'kubectl_get', arguments: '{"resource":"pods"}' }] }),
      openaiCompletion({ content: 'There are 3 pods.' }),
    )
    const events = await collect(openaiRunner.run(ctx({ gateway: { url: 'http://gw.test', token: 'gwt' }, environmentId: 'env-1' })))
    expect(events.map(e => e.type)).toEqual(['tool_call', 'tool_result', 'text', 'done'])
    expect(events[1]).toEqual({ type: 'tool_result', tool: 'kubectl_get', result: 'pods: 3' })
    const exec = http.callsTo('/tools/execute')[0]
    expect(exec.body).toEqual({ name: 'kubectl_get', arguments: { resource: 'pods' } })
    expect(exec.headers.authorization).toBe('Bearer gwt')
    expect(exec.headers['x-orion-actor-id']).toBe('agent-1')
    expect(h.checkToolPermission).toHaveBeenCalledWith('kubectl_get', 'agent-1', 'env-1', undefined, { taskId: 't1' })
  })

  it('unreachable gateway: warning text, then proceeds without tools', async () => {
    http.route('http://gw.test/tools', text('down', 502))
    http.route('/v1/chat/completions', openaiCompletion({ content: 'no tools' }))
    const events = await collect(openaiRunner.run(ctx({ gateway: { url: 'http://gw.test', token: 't' } })))
    expect(events).toEqual<AgentEvent[]>([
      { type: 'text', content: '⚠ Could not reach gateway: Gateway listTools failed: 502 down\nProceeding without tools.\n' },
      { type: 'text', content: 'no tools' },
      { type: 'done' },
    ])
  })

  it('plan-only turns send no tools', async () => {
    http.route('/v1/chat/completions', openaiCompletion({ content: '<plan/>' }))
    await collect(openaiRunner.run(ctx({ planOnly: true, managementTools: mgmt() })))
    expect((http.callsTo('/v1/chat/completions')[0].body as Record<string, unknown>).tools).toBeUndefined()
  })

  it('provider HTTP error → error event', async () => {
    http.route('/v1/chat/completions', text('boom', 500))
    expect(await collect(openaiRunner.run(ctx()))).toEqual([{ type: 'error', error: 'OpenAI 500: boom' }])
  })

  it('pre-aborted signal → terminal [aborted] error, no request', async () => {
    const ac = new AbortController(); ac.abort()
    expect(await collect(openaiRunner.run(ctx({ signal: ac.signal })))).toEqual([
      { type: 'error', error: '[aborted] Run cancelled by caller' },
    ])
    expect(http.callsTo('/v1/chat/completions')).toHaveLength(0)
  })
})

// ── Ollama task runner ────────────────────────────────────────────────────────

describe('ollamaRunner', () => {
  it('text-only: text, done; request shape', async () => {
    http.route('/api/chat', ollamaChat({ content: 'hello' }))
    const events = await collect(ollamaRunner.run(ctx({ modelId: 'ollama:llama3' })))
    expect(events).toEqual<AgentEvent[]>([{ type: 'text', content: 'hello' }, { type: 'done' }])
    const [call] = http.callsTo('/api/chat')
    expect(call.url).toBe('http://ollama.test/api/chat')
    expect(call.body).toEqual({
      model: 'llama3', stream: false,
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'TASK Fix itDescription: desc' }],
    })
  })

  it('tool call with plan text: text first, then tool_call/tool_result', async () => {
    http.route('/api/chat',
      ollamaChat({ content: '<plan>p</plan>', tool_calls: [{ name: 'orion_update_task', arguments: '{"id":1}' }] }),
      ollamaChat({ content: 'done' }),
    )
    const events = await collect(ollamaRunner.run(ctx({ modelId: 'ollama:llama3', managementTools: mgmt() })))
    expect(events).toEqual<AgentEvent[]>([
      { type: 'text', content: '<plan>p</plan>' },
      { type: 'tool_call', tool: 'orion_update_task', args: '{"id":1}' },
      { type: 'tool_result', tool: 'orion_update_task', result: 'ran orion_update_task' },
      { type: 'text', content: 'done' },
      { type: 'done' },
    ])
    const second = http.callsTo('/api/chat')[1].body as { messages: Array<Record<string, unknown>> }
    expect(second.messages.at(-1)).toEqual({ role: 'tool', content: 'ran orion_update_task' })
  })

  it('denial and validation texts match the OpenAI runner', async () => {
    h.checkToolPermission.mockResolvedValueOnce({ allowed: false, reason: 'blocked' })
    http.route('/api/chat',
      ollamaChat({ tool_calls: [{ name: 'orion_update_task', arguments: '{}' }] }),
      ollamaChat({ content: 'k' }),
    )
    const events = await collect(ollamaRunner.run(ctx({ modelId: 'ollama:m', managementTools: mgmt() })))
    expect(events[1]).toEqual({ type: 'tool_result', tool: 'orion_update_task', result: "Permission denied for tool 'orion_update_task': blocked. Contact an admin to grant access." })
  })

  it('HTTP error → error event', async () => {
    http.route('/api/chat', text('bad', 503))
    expect(await collect(ollamaRunner.run(ctx({ modelId: 'ollama:m' })))).toEqual([{ type: 'error', error: 'Ollama 503: bad' }])
  })
})

// ── Claude sidecar task runner ───────────────────────────────────────────────

describe('claudeRunner', () => {
  it('collect: text + usage + done; sends agent MCP context and decrypted token', async () => {
    http.route('/run/collect', json({ text: 'Did it.', usage: { input_tokens: 100, output_tokens: 20 } }))
    const events = await collect(claudeRunner.run(ctx({ modelId: 'claude:claude-sonnet-4-6' })))
    expect(events).toEqual<AgentEvent[]>([
      { type: 'text', content: 'Did it.' },
      { type: 'usage', inputTokens: 100, outputTokens: 20 },
      { type: 'done' },
    ])
    expect(http.callsTo('/run/collect')[0].body).toEqual({
      prompt: 'TASK Fix itDescription: desc',
      systemPrompt: 'SYS',
      model: 'claude-sonnet-4-6',
      agentId: 'agent-1',
      maxTurns: 20,
      mcpToken: 'dec(enc-token)',
      // Structured fields added by the engine consolidation (legacy fields above unchanged)
      system: 'SYS',
      messages: [{ role: 'user', content: 'TASK Fix itDescription: desc' }],
    })
  })

  it('plan-only: no agentId (no MCP tools), one turn', async () => {
    http.route('/run/collect', json({ text: '<plan/>' }))
    await collect(claudeRunner.run(ctx({ modelId: 'claude:x', planOnly: true })))
    const body = http.callsTo('/run/collect')[0].body as Record<string, unknown>
    expect(body.agentId).toBeUndefined()
    expect(body.mcpToken).toBeUndefined()
    expect(body.maxTurns).toBe(1)
  })

  it('checkpointed steps are listed in the prompt', async () => {
    http.route('/run/collect', json({ text: 'ok' }))
    await collect(claudeRunner.run(ctx({ modelId: 'claude:x', checkpoints: new Map([[1, { toolName: 't', result: 'r' }]]) })))
    expect((http.callsTo('/run/collect')[0].body as { prompt: string }).prompt).toContain('Step 1 [t]: r')
  })

  it('sidecar error field and HTTP failure → error events', async () => {
    http.route('/run/collect', json({ error: 'auth expired' }), text('nope', 500))
    expect(await collect(claudeRunner.run(ctx({ modelId: 'claude:x' })))).toEqual([{ type: 'error', error: 'auth expired' }])
    expect(await collect(claudeRunner.run(ctx({ modelId: 'claude:x' })))).toEqual([
      { type: 'error', error: 'orion-claude sidecar returned HTTP 500: nope' },
    ])
  })
})
