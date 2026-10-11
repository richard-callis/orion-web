/**
 * Characterization tests for the chat-room agent LLM calls (room-agents.ts):
 * the OpenAI-compatible tool loop (callOpenAIChat) and the Claude sidecar
 * call (callClaude). Pins replies, token accounting, tool dispatch/denial,
 * the fake-tool-call correction, tool-name auto-correction, the result cache
 * and the forced final turn when tool rounds run out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeHttp, json, text, openaiCompletion } from './testing/fake-http'

const h = vi.hoisted(() => ({
  prisma: {
    systemSetting: { findUnique: vi.fn() },
    chatMessage: { create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'msg', createdAt: new Date(0), ...a.data })) },
  },
  checkToolPermission: vi.fn(),
  executeRegisteredTool: vi.fn(),
  publishChatMessage: vi.fn(async () => {}),
  auditToolCall: vi.fn(),
  getRunTokenCap: vi.fn(async () => 400_000),
  // Default tier:'read' matches orion_list_secrets (tools/secrets.ts), the
  // tool the existing auto-correction test resolves to. Override per-test
  // (mockReturnValueOnce) to exercise the write/destructive-blocking branch.
  getToolDefinition: vi.fn(() => ({ tier: 'read' as const })),
}))

vi.mock('@/lib/db', () => ({ prisma: h.prisma }))
vi.mock('@/lib/typing-state', () => ({ setTyping: vi.fn(), clearTyping: vi.fn() }))
vi.mock('@/lib/agent-tools', () => ({ TOOLS_SYSTEM_ADDENDUM: '\n\n[TOOLS ADDENDUM]' }))
// registerTool: room-agents.ts now side-effect-imports tool-registry-bootstrap.ts,
// which calls registerTool() at module load (siem/github/skill tool registration)
// — a no-op here is fine, this suite only exercises dispatch, not registration.
// getToolDefinition: only consulted on the fuzzy auto-correction path, to gate
// auto-execution to tier==='read' tools — see h.getToolDefinition above.
vi.mock('@/lib/tool-registry', () => ({
  executeRegisteredTool: h.executeRegisteredTool,
  registerTool: vi.fn(),
  getToolDefinition: h.getToolDefinition,
}))
vi.mock('@/lib/room-tools', () => ({
  buildRoomToolSchemas: vi.fn(async () => [
    { type: 'function', function: { name: 'orion_list_secrets', description: 'list secrets', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'list_tools', description: 'list tools', parameters: { type: 'object' } } },
    // tier:'destructive' in production (tools/room.ts) — used by the
    // tier-gate negative test below, resolved via fuzzy match like
    // orion_list_secrets is, but must NOT auto-execute.
    { type: 'function', function: { name: 'delete_secret', description: 'delete secret', parameters: { type: 'object' } } },
  ]),
}))
vi.mock('@/lib/tool-permissions', () => ({ checkToolPermission: h.checkToolPermission }))
vi.mock('@/lib/chat-redis', () => ({ publishChatMessage: h.publishChatMessage }))
vi.mock('@/lib/agent-gateway', () => ({ resolveAgentGateway: vi.fn() }))
vi.mock('@/lib/claude', () => ({ matchAndInjectSkills: vi.fn() }))
vi.mock('@/lib/skill-tools', () => ({ resolveAgentPrimaryEnvironmentId: vi.fn(), registerSkillTools: vi.fn() }))
vi.mock('@/lib/agent-context', () => ({
  buildAgentContext: vi.fn(), buildAgentLocalContext: vi.fn(), buildRoomLocalContext: vi.fn(),
  invalidateSnapshotCache: vi.fn(), getModelContextLimit: vi.fn(async () => 32768), getClaudeContextLimit: vi.fn(() => 200000),
}))
vi.mock('@/lib/compaction', () => ({ compactRoom: vi.fn(), publishCompactionWarning: vi.fn(), publishTokenUpdate: vi.fn() }))
vi.mock('@/lib/llm-budget', async (orig) => ({
  ...(await orig<typeof import('../llm-budget')>()),
  getRunTokenCap: h.getRunTokenCap,
  beginBudgetedRun: vi.fn(),
}))
vi.mock('@/lib/model-roles', () => ({ resolveModel: vi.fn(async () => 'claude-haiku') }))
vi.mock('@/lib/rate-limit-redis', () => ({ rateLimitRedis: vi.fn() }))
vi.mock('@/lib/security/audit-emitter', () => ({ auditToolCall: h.auditToolCall }))
vi.mock('@/lib/redact', () => ({ redactSecrets: (s: string) => s }))
vi.mock('@/lib/system-prompts', () => ({ getPrompt: vi.fn(async () => '') }))

import { callOpenAIChat, callClaude } from '../room-agents'
import { GatewayClient } from './gateway-client'

let http: FakeHttp
const history = [
  { name: 'Alice', content: 'hi team', isSelf: false },
  { name: 'Bot', content: 'hello', isSelf: true },
]
const toolCtx = { roomId: 'room-1', agentId: 'agent-1', llm: 'ext:m' }

beforeEach(() => {
  http = new FakeHttp()
  http.install()
  h.prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null)
  h.prisma.chatMessage.create.mockClear()
  h.checkToolPermission.mockReset().mockResolvedValue({ allowed: true })
  h.executeRegisteredTool.mockReset().mockImplementation(async (name: string) => `registry:${name}`)
  h.publishChatMessage.mockClear()
  h.auditToolCall.mockClear()
  h.getRunTokenCap.mockResolvedValue(400_000)
})
afterEach(() => vi.unstubAllGlobals())

describe('callOpenAIChat (room)', () => {
  it('plain reply: request shape and token accounting', async () => {
    http.route('/v1/chat/completions', openaiCompletion({ content: '  Sure thing.  ' }, { prompt_tokens: 50, completion_tokens: 5 }))
    const r = await callOpenAIChat('Bot', 'PERSONA', ['Alice'], history, 'Alice: status?', 'qwen2', 'http://llm.test', 'key')
    expect(r).toEqual({ reply: 'Sure thing.', tokensUsed: 50, contextLimit: 32768, inputTokens: 50, outputTokens: 5 })
    const [call] = http.callsTo('/v1/chat/completions')
    expect(call.url).toBe('http://llm.test/v1/chat/completions')
    const body = call.body as { model: string; stream: boolean; tools?: unknown; messages: Array<{ role: string; content: string }> }
    expect(body.model).toBe('qwen2')
    expect(body.stream).toBe(false)
    expect(body.tools).toBeUndefined()
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content.startsWith('IMPORTANT — YOUR ROLE:\nYou are Bot.')).toBe(true)
    expect(body.messages.slice(1)).toEqual([
      { role: 'user', content: 'Alice: hi team' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'Alice: status?' },
    ])
  })

  it('qwen3 models get think:false', async () => {
    http.route('/v1/chat/completions', openaiCompletion({ content: 'ok' }))
    await callOpenAIChat('Bot', 'P', [], [], 'x', 'qwen3:8b', 'http://llm.test')
    expect((http.callsTo('/v1/chat/completions')[0].body as Record<string, unknown>).think).toBe(false)
  })

  it('registry tool: permission check, execute, persisted + published tool_call message', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ content: null, tool_calls: [{ id: 't1', name: 'orion_list_secrets', arguments: '{"env":"prod"}' }] }, { prompt_tokens: 10, completion_tokens: 2 }),
      openaiCompletion({ content: 'Found 2.' }, { prompt_tokens: 20, completion_tokens: 3 }),
    )
    const r = await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test', null, toolCtx)
    expect(r).toEqual({ reply: 'Found 2.', tokensUsed: 20, contextLimit: 32768, inputTokens: 30, outputTokens: 5 })
    expect(h.checkToolPermission).toHaveBeenCalledWith('orion_list_secrets', 'agent-1', null)
    expect(h.executeRegisteredTool).toHaveBeenCalledWith('orion_list_secrets', { env: 'prod' }, expect.objectContaining({ agentId: 'agent-1', roomId: 'room-1' }))
    expect(h.prisma.chatMessage.create).toHaveBeenCalledWith({ data: {
      roomId: 'room-1', agentId: 'agent-1', senderType: 'tool_call', content: 'orion_list_secrets',
      attachments: { tool: 'orion_list_secrets', input: '{"env":"prod"}', output: 'registry:orion_list_secrets' },
    } })
    expect(h.publishChatMessage).toHaveBeenCalledTimes(1)
    const second = http.callsTo('/v1/chat/completions')[1].body as { messages: unknown[]; tools: unknown[] }
    expect(second.messages.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'orion_list_secrets', arguments: '{"env":"prod"}' } }] },
      { role: 'tool', content: 'registry:orion_list_secrets', tool_call_id: 't1', name: 'orion_list_secrets' },
    ])
    // 3, not 2: buildRoomToolSchemas' mock now also returns delete_secret
    // (added for the tier-gate negative test below) — unrelated to this test.
    expect(second.tools).toHaveLength(3)
    expect(h.auditToolCall).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'orion_list_secrets', outcome: 'executed' }))
  })

  it('denied registry tool and allowlist enforcement at dispatch', async () => {
    h.checkToolPermission.mockResolvedValueOnce({ allowed: false, reason: 'no grant' })
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'orion_list_secrets', arguments: '{}' }] }),
      openaiCompletion({ tool_calls: [{ id: 'b', name: 'list_tools', arguments: '{}' }] }),
      openaiCompletion({ content: 'done' }),
    )
    await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test', null, { ...toolCtx, allowedTools: new Set(['orion_list_secrets']) })
    const outputs = h.prisma.chatMessage.create.mock.calls.map(c => (c[0] as { data: { attachments: { output: string } } }).data.attachments.output)
    expect(outputs).toEqual([
      'Permission denied: no grant. An admin can grant access under Admin → Agents → Tool Permissions.',
      "Permission denied: tool 'list_tools' is not in this agent's allowed tool list. An admin can grant access under Admin → Agents → Tool Permissions.",
    ])
    // Only the allowlisted tool is offered
    expect((http.callsTo('/v1/chat/completions')[0].body as { tools: Array<{ function: { name: string } }> }).tools.map(t => t.function.name)).toEqual(['orion_list_secrets'])
  })

  it('fake tool call written as prose → correction turn', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ content: 'kubectl_get_pods' }),
      openaiCompletion({ content: 'There are no pods.' }),
    )
    const r = await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test', null, toolCtx)
    expect(r.reply).toBe('There are no pods.')
    const second = http.callsTo('/v1/chat/completions')[1].body as { messages: Array<{ role: string; content: string }> }
    expect(second.messages.at(-2)).toEqual({ role: 'assistant', content: 'kubectl_get_pods' })
    expect(second.messages.at(-1)!.content).toMatch(/^Your last reply looked like a tool call written as plain text \("kubectl_get_pods"\)/)
  })

  it('hallucinated tool name auto-corrected with high confidence', async () => {
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'list_secrets', arguments: '{}' }] }),
      openaiCompletion({ content: 'ok' }),
    )
    await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test', null, toolCtx)
    const out = (h.prisma.chatMessage.create.mock.calls[0][0] as { data: { attachments: { output: string } } }).data.attachments.output
    expect(out).toBe('[Note: corrected "list_secrets" → "orion_list_secrets"]\nregistry:orion_list_secrets')
  })

  it('hallucinated tool name resolving to a write/destructive tool is NOT auto-executed', async () => {
    h.getToolDefinition.mockReturnValueOnce({ tier: 'destructive' })
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'delete_secret_now', arguments: '{}' }] }),
      openaiCompletion({ content: 'ok' }),
    )
    await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test', null, toolCtx)
    expect(h.executeRegisteredTool).not.toHaveBeenCalled()
    const out = (h.prisma.chatMessage.create.mock.calls[0][0] as { data: { attachments: { output: string } } }).data.attachments.output
    expect(out).toContain('did not execute')
    expect(out).toContain('tier="destructive"')
    expect(out).toContain('delete_secret')
  })

  it('gateway tool results are cached within the session', async () => {
    const client = new GatewayClient('http://gw.test', 'gwt')
    http.route('http://gw.test/tools/execute', json({ result: 'pod-a' }))
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'kubectl_get', arguments: '{"r":"pods"}' }] }),
      openaiCompletion({ tool_calls: [{ id: 'b', name: 'kubectl_get', arguments: '{"r":"pods"}' }] }),
      openaiCompletion({ content: 'one pod' }),
    )
    await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test', null, toolCtx,
      { url: 'http://gw.test', token: 'gwt', client, environmentId: 'env-1' },
      [{ name: 'kubectl_get', description: 'get', inputSchema: { type: 'object' } }])
    expect(http.callsTo('/tools/execute')).toHaveLength(1)
    const outputs = h.prisma.chatMessage.create.mock.calls.map(c => (c[0] as { data: { attachments: { output: string } } }).data.attachments.output)
    expect(outputs).toEqual(['pod-a', '[Cached result — fetched earlier this session]\npod-a'])
  })

  it('gateway tools go through the agent permission check (grant rule) — denied ones never reach the gateway', async () => {
    const client = new GatewayClient('http://gw.test', 'gwt')
    h.checkToolPermission.mockResolvedValue({ allowed: false, reason: '`kubectl_delete` has not been granted to agent "Bot".' })
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'kubectl_delete', arguments: '{"r":"x"}' }] }),
      openaiCompletion({ content: 'cannot' }),
    )
    await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test', null, toolCtx,
      { url: 'http://gw.test', token: 'gwt', client, environmentId: 'env-1' },
      [{ name: 'kubectl_delete', description: 'delete', inputSchema: { type: 'object' } }])
    expect(h.checkToolPermission).toHaveBeenCalledWith('kubectl_delete', 'agent-1', 'env-1')
    expect(http.callsTo('/tools/execute')).toHaveLength(0)
    const out = (h.prisma.chatMessage.create.mock.calls[0][0] as { data: { attachments: { output: string } } }).data.attachments.output
    expect(out).toBe('Permission denied: `kubectl_delete` has not been granted to agent "Bot".')
  })

  it('tool rounds exhausted → forced final turn without tools, cut-off notice', async () => {
    h.prisma.systemSetting.findUnique.mockResolvedValue({ value: '1' })
    http.route('/v1/chat/completions',
      openaiCompletion({ tool_calls: [{ id: 'a', name: 'orion_list_secrets', arguments: '{}' }] }, { prompt_tokens: 5, completion_tokens: 1 }),
      openaiCompletion({ content: 'Partial summary.' }, { prompt_tokens: 9, completion_tokens: 2 }),
    )
    const r = await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test', null, toolCtx)
    expect(r).toEqual({
      reply: '> ⚠️ **Tool round limit reached** (1 rounds). The agent was cut off before completing all steps. Summary of progress so far:\n\nPartial summary.',
      tokensUsed: 9, contextLimit: 32768, inputTokens: 14, outputTokens: 3,
    })
    expect((http.callsTo('/v1/chat/completions')[1].body as Record<string, unknown>).tools).toBeUndefined()
  })

  it('HTTP error → null reply (retries 5xx up to LLM_RETRY_MAX_ATTEMPTS, then gives up)', async () => {
    http.route('/v1/chat/completions', text('x', 500), text('x', 500), text('x', 500))
    expect(await callOpenAIChat('Bot', 'P', [], [], 'x', 'm', 'http://llm.test')).toEqual({
      reply: null, tokensUsed: 0, contextLimit: 32768, inputTokens: 0, outputTokens: 0,
    })
    expect(http.callsTo('/v1/chat/completions')).toHaveLength(3)
  })
})

describe('callClaude (room)', () => {
  it('MCP-enabled room call: flattened history prompt, agent/room ids, token fallback estimate', async () => {
    http.route('/run/collect', json({ text: ' Hello room ' }))
    const r = await callClaude('Bot', 'P', ['Alice'], history, 'Alice: hi', 'claude-x', true, 'agent-1', 'room-1')
    expect(r.text).toBe('Hello room')
    expect(r.inputTokens).toBeGreaterThan(0)
    expect(r.outputTokens).toBeGreaterThan(0)
    const body = http.callsTo('/run/collect')[0].body as Record<string, unknown>
    expect(body.prompt).toBe('Alice: hi team\nBot: hello\n\nAlice: hi')
    expect(body).toMatchObject({ agentId: 'agent-1', roomId: 'room-1', maxTurns: 6, model: 'claude-x' })
    expect(String(body.systemPrompt)).toContain('## ORION Tools')
  })

  it('reported usage wins over the estimate', async () => {
    http.route('/run/collect', json({ text: 'x', usage: { inputTokens: 11, outputTokens: 7 } }))
    const r = await callClaude('Bot', 'P', [], [], 'hi')
    expect(r).toEqual({ text: 'x', inputTokens: 11, outputTokens: 7 })
    expect((http.callsTo('/run/collect')[0].body as Record<string, unknown>).maxTurns).toBe(1)
  })

  it('errors are mapped to user-facing hints', async () => {
    // A sidecar-reported app error (no HTTP status) is never retried — one
    // queued response is enough. A real 5xx is retried up to 3x; in
    // production a persistent failure like a missing binary returns the
    // same error every attempt, so the final mapped message is unchanged —
    // queue the same response 3x to mirror that (not a workaround).
    http.route('/run/collect',
      json({ error: 'OAuth token expired' }),
      text('ENOENT claude', 500), text('ENOENT claude', 500), text('ENOENT claude', 500),
    )
    expect(await callClaude('Bot', 'P', [], [], 'hi')).toEqual({ text: null, error: 'authentication issue', inputTokens: 0, outputTokens: 0 })
    expect(await callClaude('Bot', 'P', [], [], 'hi')).toEqual({ text: null, error: 'claude binary not installed', inputTokens: 0, outputTokens: 0 })
  })

  it('a useMcp session (agentId+roomId) is never retried — only one attempt even on a 5xx', async () => {
    // Unlike the plain-completion path above, a useMcp call runs tool calls
    // (including writes) server-side inside the sidecar before returning.
    // Retrying it from scratch on a late failure risks double-executing
    // whatever already ran. Exactly one fake response is queued — if this
    // regresses to retrying useMcp sessions, the second attempt would hit
    // "no route" and this assertion on call count would fail.
    http.route('/run/collect', text('ENOENT claude', 500))
    const r = await callClaude('Bot', 'P', [], [], 'hi', undefined, false, 'agent-1', 'room-1')
    expect(r).toEqual({ text: null, error: 'claude binary not installed', inputTokens: 0, outputTokens: 0 })
    expect(http.callsTo('/run/collect')).toHaveLength(1)
  })
})
