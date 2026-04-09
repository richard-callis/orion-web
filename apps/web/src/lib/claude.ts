import fs from 'fs'
import path from 'path'
import { prisma } from './db'
import type { SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-code'

// Tool allowlist — read-only kubectl only
export const ALLOWED_TOOLS = [
  'Bash(kubectl get:*)',
  'Bash(kubectl describe:*)',
  'Bash(kubectl logs:*)',
  'Bash(kubectl top:*)',
]

function getSystemPrompt(toolNames: string[] = []): string {
  const claudeMdPath = process.env.CLAUDE_MD_PATH ?? '/claude-config/CLAUDE.md'
  let clusterContext = ''
  try {
    clusterContext = fs.readFileSync(claudeMdPath, 'utf8')
  } catch {
    clusterContext = '# Homelab cluster — no context file mounted'
  }

  if (toolNames.length === 0) {
    return `You are ORION, an AI assistant for homelab infrastructure management.

No gateway is connected right now. You cannot run commands or query the cluster.
When asked about cluster state, be honest: say you have no gateway connected and cannot run commands.
Do not list commands you would hypothetically run. Do not invent output. Just say you don't have access.`
  }

  return `You are ORION, an AI assistant managing homelab infrastructure.

CURRENT STATE — READ THIS CAREFULLY:
You have ${toolNames.length} tools connected and working RIGHT NOW: ${toolNames.join(', ')}.
This is the authoritative system state. Any earlier messages in this conversation that claimed "no gateway connected" or "I can't run commands" were from a previous state — they are now WRONG. Ignore them.

Tool usage rules:
- Call tools immediately when you need real data. Do not ask permission first.
- NEVER make up or hallucinate command output. Always use a tool and return its real result.
- If a tool fails, report the actual error message.
- If a tool has optional parameters (flags, filters, selectors), USE THEM to give the best answer. Do not default to bare invocations when flags would give more complete or relevant results.
- If an initial tool result does not fully answer the question, run it again with better options (e.g. scan a specific port, increase verbosity, filter by namespace). Never just say "it wasn't found" without checking more thoroughly first.
- You may call the same tool multiple times in one turn if needed to get complete information.
- If you need a capability that isn't in the tool list, use propose_tool to request it.

Safety — do NOT use tools in ways that would harm the homelab:
- No mass deletion (kubectl delete all, docker rm -f on everything, rm -rf on broad paths)
- No commands that would take down core services (DNS, ingress, auth)
- No writing or overwriting production secrets or credentials
- Everything else that is informational, diagnostic, or a targeted change is fair game — use your judgement.

${clusterContext}`
}

function getPlanningSystemPrompt(targetType: string): string {
  const claudeMdPath = process.env.CLAUDE_MD_PATH ?? '/claude-config/CLAUDE.md'
  let clusterContext = ''
  try { clusterContext = fs.readFileSync(claudeMdPath, 'utf8') } catch { clusterContext = '# K3s Homelab — context file not mounted' }

  const scope = targetType === 'epic' ? 'high-level epic (will be broken into features)'
    : targetType === 'feature' ? 'feature (will be broken into backlog tasks)'
    : 'task (concrete implementation steps)'

  return `You are ORION, a technical planning assistant for a homelab infrastructure project.

${clusterContext}

PLANNING MODE — you are creating a plan for a ${scope}:
- Run kubectl commands freely to inspect the cluster and gather information before planning
- Ask clarifying questions if you genuinely need more information to produce a good plan
- When you have gathered enough information and are ready to write the final plan, produce it in full:
  - Use clear sections: Overview, Implementation Steps, Technical Details, Risks & Mitigations
  - Be specific and actionable — this plan will be saved and used to auto-generate ${targetType === 'epic' ? 'features' : 'tasks'}
  - Do NOT end the plan itself with open-ended questions like "What would you like to prioritize?" — the plan should be complete and self-contained`
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error'
  content?: string
  tool?: string
  input?: string
  output?: string
  error?: string
}

// Collect all text from a query() response into a single string
type AnyMsg = { type: string; message?: { content: Array<{ type: string; text?: string }> }; subtype?: string; result?: string }

async function collectQueryText(response: AsyncIterable<unknown>): Promise<string> {
  let text = ''
  for await (const raw of response) {
    const msg = raw as AnyMsg
    if (msg.type === 'assistant' && msg.message) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) text += block.text
      }
    } else if (msg.type === 'result' && msg.subtype === 'success' && msg.result && !text.includes(msg.result.trim())) {
      text += msg.result
    }
  }
  return text.trim()
}

function getOAuthToken(): string | null {
  // Try the CLAUDE_CREDENTIALS env var first (raw JSON blob set by ESO)
  if (process.env.CLAUDE_CREDENTIALS) {
    try {
      const parsed = JSON.parse(process.env.CLAUDE_CREDENTIALS)
      const token = parsed?.claudeAiOauth?.accessToken
      if (token) return token
    } catch { /* fall through */ }
  }
  // Fall back to mounted credentials file
  const candidates = [
    process.env.CLAUDE_CREDENTIALS_PATH
      ? path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
      : null,
    '/tmp/claude-home/.claude/.credentials.json',
  ].filter(Boolean) as string[]
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      const token = parsed?.claudeAiOauth?.accessToken
      if (token) return token
    } catch { /* try next */ }
  }
  return null
}

export interface AgentContextConfig {
  maxTurns?: number        // default 6 for agent chats
  historyMessages?: number // default 6 for agent chats
  allowedTools?: string[]  // default [] (no tools) for agent chats
  summarizeAfter?: number  // summarize conversation after this many messages (default 20)
  llm?: string             // "claude:<model-id>" | "ollama:<model-id>" | "gemini:<model-id>" | "ext:<cuid>" — defaults to Claude Sonnet
}

// ── Permission check ─────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2 }

async function checkToolPermission(
  toolName: string,
  toolArgs: Record<string, unknown>,
  environmentId: string,
  conversationId: string,
  userId: string | undefined,
): Promise<{ allowed: boolean; reason?: string }> {
  // No userId — treat as unauthenticated viewer
  const uid = userId ?? '__anon__'

  // Check if tool is agent-restricted (only specific agents may run it)
  const restrictionCount = await prisma.toolAgentRestriction.count({
    where: { tool: { name: toolName, environmentId } },
  })
  if (restrictionCount > 0) {
    return { allowed: false, reason: `\`${toolName}\` is restricted to specific agents only and cannot be called from human chat.` }
  }

  // Check if caller is a global admin — admins bypass all tier checks
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    if (user?.role === 'admin') return { allowed: true }
  }

  // Find which tool groups this tool belongs to (in this environment)
  const toolGroupMemberships = await prisma.toolGroupTool.findMany({
    where: { tool: { name: toolName, environmentId } },
    include: { toolGroup: true },
  })

  // No group membership = unrestricted
  if (toolGroupMemberships.length === 0) return { allowed: true }

  // Get user's tier in this environment (default: viewer)
  const tierRecord = userId
    ? await prisma.environmentUserTier.findUnique({ where: { userId_environmentId: { userId, environmentId } } })
    : null
  const userTierRank = TIER_RANK[tierRecord?.tier ?? 'viewer'] ?? 0

  // Check if user meets minimum tier for ANY of the groups this tool is in
  // (tool is accessible if the user qualifies for at least one of the groups)
  const blocked = toolGroupMemberships.every(m => {
    const required = TIER_RANK[m.toolGroup.minimumTier] ?? 0
    return userTierRank < required
  })

  if (!blocked) return { allowed: true }

  // User is blocked — check for a one-time execution grant
  const grant = userId ? await prisma.toolExecutionGrant.findFirst({
    where: {
      userId,
      environmentId,
      toolName,
      usedAt:    null,
      expiresAt: { gt: new Date() },
    },
  }) : null

  if (grant) {
    // Consume the grant
    await prisma.toolExecutionGrant.update({ where: { id: grant.id }, data: { usedAt: new Date() } })
    return { allowed: true }
  }

  // Create an approval request
  const minRequired = toolGroupMemberships.reduce((min, m) => {
    const r = TIER_RANK[m.toolGroup.minimumTier] ?? 0
    return r > min ? r : min
  }, 0)
  const requiredTierName = Object.entries(TIER_RANK).find(([, v]) => v === minRequired)?.[0] ?? 'operator'

  // Don't create duplicate pending requests for the same tool in this conversation
  const existing = await prisma.toolApprovalRequest.findFirst({
    where: { conversationId, toolName, status: 'pending' },
  })
  if (!existing) {
    await prisma.toolApprovalRequest.create({
      data: {
        conversationId,
        userId: uid,
        environmentId,
        toolName,
        toolArgs,
        reason: `User's tier is below the minimum required (${requiredTierName}) for this tool group.`,
      },
    })
  }

  return {
    allowed: false,
    reason: `\`${toolName}\` requires **${requiredTierName}** access in this environment. An approval request has been submitted — an administrator can approve it, after which you can retry.`,
  }
}

export async function* streamOllamaChat(
  prompt: string,
  conversationId: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  baseUrl?: string,
  abortSignal?: AbortSignal,
  userId?: string,
): AsyncGenerator<StreamChunk> {
  // Load tools from the first connected gateway (if any)
  const { GatewayClient } = await import('./agent-runner/gateway-client')
  type GatewayTool = import('./agent-runner/types').GatewayTool
  let gatewayTools: GatewayTool[] = []
  let gatewayClient: InstanceType<typeof GatewayClient> | null = null

  const connectedEnv = await prisma.environment.findFirst({
    where: { status: 'connected', gatewayUrl: { not: null }, gatewayToken: { not: null } },
  })
  if (connectedEnv?.gatewayUrl && connectedEnv.gatewayToken) {
    gatewayClient = new GatewayClient(connectedEnv.gatewayUrl, connectedEnv.gatewayToken)
    try {
      gatewayTools = await gatewayClient.listTools()
    } catch {
      // Gateway unreachable — proceed without tools
    }
  }

  // No gateway — fall through to regular streaming chat with an honest system prompt
  if (!gatewayTools.length || !gatewayClient) {
    yield* streamOllamaAgentChat(prompt, conversationId, getSystemPrompt([]), history, model, baseUrl, undefined, abortSignal)
    return
  }

  // Tools available — run agentic loop (non-streaming turns with tool execution)
  const systemPrompt = getSystemPrompt(gatewayTools.map(t => t.name))
  yield* streamOllamaToolLoop(prompt, conversationId, systemPrompt, history, model, baseUrl, gatewayTools, gatewayClient, connectedEnv!.id, abortSignal, userId)
}

interface OllamaMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ function: { name: string; arguments: string | Record<string, unknown> } }>
}

async function* streamOllamaToolLoop(
  prompt: string,
  conversationId: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  baseUrl: string | undefined,
  tools: import('./agent-runner/types').GatewayTool[],
  gateway: import('./agent-runner/gateway-client').GatewayClient,
  environmentId: string,
  abortSignal?: AbortSignal,
  userId?: string,
): AsyncGenerator<StreamChunk> {
  const { GatewayClient: _GC } = await import('./agent-runner/gateway-client')
  void _GC

  let ollamaUrl = baseUrl
  let timeoutSecs = 120
  if (!ollamaUrl) {
    const extModel = await prisma.externalModel.findFirst({ where: { provider: 'ollama', modelId: model, enabled: true } })
      ?? await prisma.externalModel.findFirst({ where: { provider: 'ollama', enabled: true } })
    if (!extModel?.baseUrl) { yield { type: 'error', error: 'No Ollama model configured' }; return }
    ollamaUrl = extModel.baseUrl
    timeoutSecs = extModel.timeoutSecs ?? 120
  }

  // Synthetic propose_tool — handled locally, never forwarded to the gateway
  const proposeToolDef = {
    type: 'function',
    function: {
      name: 'propose_tool',
      description: 'Propose a new tool to be added to this environment\'s gateway. Use this when you need a command that isn\'t available. A human must approve it before you can use it.',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'snake_case tool name, e.g. kubectl_get_pods' },
          description: { type: 'string', description: 'What the tool does' },
          command:     { type: 'string', description: 'Shell command with {param} placeholders, e.g. kubectl get pods -n {namespace}' },
          parameters:  { type: 'object', description: 'Parameter definitions — keys are param names, values have type and description' },
          reason:      { type: 'string', description: 'Why this tool is needed right now' },
        },
        required: ['name', 'description', 'command'],
      },
    },
  }

  const ollamaToolDefs = [
    ...tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    proposeToolDef,
  ]

  const messages: OllamaMsg[] = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: prompt },
  ]

  const start = Date.now()
  let totalText = ''
  const MAX_TURNS = 15

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const fetchSignal = abortSignal
        ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutSecs * 1000)])
        : AbortSignal.timeout(timeoutSecs * 1000)

      const res = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, tools: ollamaToolDefs }),
        signal: fetchSignal,
      })
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)
      const data = await res.json() as { message: OllamaMsg; done: boolean }
      const assistantMsg = data.message
      messages.push(assistantMsg)

      if (assistantMsg.tool_calls?.length) {
        for (const toolCall of assistantMsg.tool_calls) {
          const fn = toolCall.function
          const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments as Record<string, unknown>

          // Handle propose_tool locally
          if (fn.name === 'propose_tool') {
            yield { type: 'tool_call', tool: 'propose_tool', input: JSON.stringify(args) }
            let result: string
            try {
              const toolName = String(args.name ?? '').trim().replace(/\s+/g, '_')
              const parameters = (args.parameters as Record<string, { type: string; description?: string }> | undefined) ?? {}
              // Build inputSchema from parameters
              const inputSchema = {
                type: 'object',
                properties: Object.fromEntries(
                  Object.entries(parameters).map(([k, v]) => [k, { type: v.type ?? 'string', description: v.description }])
                ),
                required: Object.keys(parameters),
              }
              await prisma.mcpTool.create({
                data: {
                  environmentId: environmentId,
                  name:        toolName,
                  description: String(args.description ?? ''),
                  inputSchema: inputSchema,
                  execType:    'shell',
                  execConfig:  { command: String(args.command ?? '') },
                  enabled:     false,
                  builtIn:     false,
                  status:      'pending',
                  proposedBy:  conversationId,
                  proposedAt:  new Date(),
                },
              })
              result = `Tool '${toolName}' has been proposed and is awaiting human approval. Once approved it will be available for use. Reason recorded: ${args.reason ?? 'not specified'}`
            } catch (err) {
              result = `Failed to propose tool: ${err instanceof Error ? err.message : String(err)}`
            }
            yield { type: 'tool_result', tool: 'propose_tool', output: result }
            messages.push({ role: 'tool', content: result })
            continue
          }

          yield { type: 'tool_call', tool: fn.name, input: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments) }

          // Permission check — must happen before forwarding to gateway
          const perm = await checkToolPermission(fn.name, args, environmentId, conversationId, userId)
          let result: string
          if (!perm.allowed) {
            result = `Permission denied: ${perm.reason}`
          } else {
            try {
              result = await gateway.executeTool(fn.name, args)
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          }
          yield { type: 'tool_result', tool: fn.name, output: result }
          messages.push({ role: 'tool', content: result })
        }
        continue
      }

      if (assistantMsg.content) {
        totalText = assistantMsg.content
        yield { type: 'text', content: assistantMsg.content }
      }
      break
    }

    const MAX_STORE_CHARS = 4000
    const savedContent = totalText.length > MAX_STORE_CHARS
      ? totalText.slice(0, MAX_STORE_CHARS) + '\n[…truncated for storage]'
      : totalText
    await Promise.all([
      prisma.message.create({ data: { conversationId, role: 'user', content: prompt } }),
      prisma.message.create({ data: { conversationId, role: 'assistant', content: savedContent } }),
      prisma.claudeInvocation.create({ data: { conversationId, prompt, toolsUsed: tools.map(t => t.name), durationMs: Date.now() - start, success: true } }),
    ])
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.claudeInvocation.create({ data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: false } }).catch(() => {})
    yield { type: 'error', error: `Ollama error: ${msg}` }
  }
}

export async function* streamAgentChat(
  prompt: string,
  conversationId: string,
  agentSystemPrompt: string,
  previousMessages: Array<{ role: string; content: string }> = [],
  contextConfig: AgentContextConfig = {},
): AsyncGenerator<StreamChunk> {
  const historyLimit   = contextConfig.historyMessages ?? 6
  const summarizeAfter = contextConfig.summarizeAfter  ?? 20
  const llm            = contextConfig.llm             ?? 'claude'

  const trimmedHistory = await maybeGetSummarizedHistory(
    conversationId, previousMessages, summarizeAfter, historyLimit
  )

  if (llm.startsWith('ollama:')) {
    const model = llm.slice('ollama:'.length)
    yield* streamOllamaAgentChat(prompt, conversationId, agentSystemPrompt, trimmedHistory, model)
    return
  }

  if (llm.startsWith('gemini:')) {
    const model = llm.slice('gemini:'.length)
    yield* streamGeminiAgentChat(prompt, conversationId, agentSystemPrompt, trimmedHistory, model)
    return
  }

  if (llm.startsWith('ext:')) {
    const extId = llm.slice('ext:'.length)
    const extModel = await prisma.externalModel.findUnique({ where: { id: extId } })
    if (!extModel) {
      yield { type: 'error', error: `External model not found: ${extId}` }
      return
    }
    if (extModel.provider === 'ollama') {
      yield* streamOllamaAgentChat(prompt, conversationId, agentSystemPrompt, trimmedHistory, extModel.modelId, extModel.baseUrl, extModel.timeoutSecs ?? 120)
      return
    }
    yield { type: 'error', error: `Unsupported external model provider: ${extModel.provider}` }
    return
  }

  // Claude path — claude:<model-id> or bare 'claude' (default)
  const claudeModel  = llm.startsWith('claude:') ? llm.slice('claude:'.length) : undefined
  const maxTurns     = contextConfig.maxTurns    ?? 6
  const allowedTools = contextConfig.allowedTools ?? []

  const overridePrompt = `You are NOT Claude Code and NOT the Claude CLI. Do not mention or reference Claude Code, Anthropic's CLI, or any developer tooling.

${agentSystemPrompt}

Respond only in the persona described above. Never break character or refer to yourself as Claude Code.`

  yield* streamClaudeResponse(prompt, conversationId, trimmedHistory, null, overridePrompt, {
    maxTurns,
    allowedTools,
    ...(claudeModel && { model: claudeModel }),
  })
}

async function* streamOllamaAgentChat(
  prompt: string,
  conversationId: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  resolvedBaseUrl?: string,     // pre-resolved from ext: lookup — skips second DB query
  resolvedTimeoutSecs?: number,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  let ollamaUrl = resolvedBaseUrl
  let timeoutSecs = resolvedTimeoutSecs ?? 120
  if (!ollamaUrl) {
    const extModel = await prisma.externalModel.findFirst({
      where: { provider: 'ollama', modelId: model, enabled: true },
    }) ?? await prisma.externalModel.findFirst({
      where: { provider: 'ollama', enabled: true },
    })
    if (!extModel) throw new Error('No Ollama model configured — add one in Admin → Models')
    ollamaUrl = extModel.baseUrl
    timeoutSecs = extModel.timeoutSecs ?? 120
  }
  const start = Date.now()
  let totalText = ''

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    { role: 'user', content: prompt },
  ]

  try {
    const timeoutSignal = AbortSignal.timeout(timeoutSecs * 1000)
    const fetchSignal = abortSignal
      ? AbortSignal.any([abortSignal, timeoutSignal])
      : timeoutSignal

    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: fetchSignal,
    })

    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)
    if (!res.body) throw new Error('No response body from Ollama')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean }
          const text = chunk.message?.content ?? ''
          if (text) {
            totalText += text
            yield { type: 'text', content: text }
          }
        } catch { /* skip malformed line */ }
      }
    }

    const MAX_STORE_CHARS = 4000
    const savedContent = totalText.length > MAX_STORE_CHARS
      ? totalText.slice(0, MAX_STORE_CHARS) + '\n[…truncated for storage]'
      : totalText

    await Promise.all([
      prisma.message.create({ data: { conversationId, role: 'user', content: prompt } }),
      prisma.message.create({ data: { conversationId, role: 'assistant', content: savedContent } }),
      prisma.claudeInvocation.create({
        data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: true },
      }),
    ])
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.claudeInvocation.create({
      data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: false },
    }).catch(() => {})
    yield { type: 'error', error: `Ollama error: ${msg}` }
  }
}

export async function* streamGeminiChat(
  prompt: string,
  conversationId: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  yield* streamGeminiAgentChat(prompt, conversationId, getSystemPrompt(), history, model, abortSignal)
}

async function* streamGeminiAgentChat(
  prompt: string,
  conversationId: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    yield { type: 'error', error: 'Gemini API key not configured — add GEMINI_API_KEY to Vault secret/orion' }
    return
  }

  const start = Date.now()
  let totalText = ''

  const contents = [
    ...history.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: prompt }] },
  ]

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    const timeoutSignal = AbortSignal.timeout(120000)
    const fetchSignal = abortSignal
      ? AbortSignal.any([abortSignal, timeoutSignal])
      : timeoutSignal
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
      }),
      signal: fetchSignal,
    })

    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
    if (!res.body) throw new Error('No response body from Gemini')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data) continue
        try {
          const chunk = JSON.parse(data) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
          }
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
          if (text) {
            totalText += text
            yield { type: 'text', content: text }
          }
        } catch { /* skip malformed line */ }
      }
    }

    const MAX_STORE_CHARS = 4000
    const savedContent = totalText.length > MAX_STORE_CHARS
      ? totalText.slice(0, MAX_STORE_CHARS) + '\n[…truncated for storage]'
      : totalText

    await Promise.all([
      prisma.message.create({ data: { conversationId, role: 'user', content: prompt } }),
      prisma.message.create({ data: { conversationId, role: 'assistant', content: savedContent } }),
      prisma.claudeInvocation.create({
        data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: true },
      }),
    ])
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.claudeInvocation.create({
      data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: false },
    }).catch(() => {})
    yield { type: 'error', error: `Gemini error: ${msg}` }
  }
}

// Summarize old messages and store the summary on the conversation.
// Returns [summary context message] + last N recent messages.
async function maybeGetSummarizedHistory(
  conversationId: string,
  messages: Array<{ role: string; content: string }>,
  summarizeAfter: number,
  recentCount: number,
): Promise<Array<{ role: string; content: string }>> {
  if (messages.length <= recentCount) return messages

  // Check if we already have a stored summary
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { metadata: true },
  })
  const meta = (convo?.metadata ?? {}) as Record<string, unknown>

  // Summarize if we're over the threshold and don't have a fresh summary
  const summarizedUpTo = meta.summarizedUpTo as number | undefined
  const needsSummary = messages.length >= summarizeAfter &&
    (summarizedUpTo === undefined || messages.length - summarizedUpTo > summarizeAfter / 2)

  if (needsSummary) {
    const toSummarize = messages.slice(0, -recentCount)
    const summaryText = await generateSummary(toSummarize)
    if (summaryText) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          metadata: {
            ...meta,
            contextSummary: summaryText,
            summarizedUpTo: messages.length - recentCount,
          },
        },
      })
      return [
        { role: 'user', content: `[Previous conversation summary]\n${summaryText}` },
        { role: 'assistant', content: 'Understood, I have reviewed the conversation history.' },
        ...messages.slice(-recentCount),
      ]
    }
  }

  // Use existing summary if available
  if (meta.contextSummary) {
    return [
      { role: 'user', content: `[Previous conversation summary]\n${meta.contextSummary as string}` },
      { role: 'assistant', content: 'Understood, I have reviewed the conversation history.' },
      ...messages.slice(-recentCount),
    ]
  }

  return messages.slice(-recentCount)
}

async function generateSummary(messages: Array<{ role: string; content: string }>): Promise<string | null> {
  if (messages.length === 0) return null
  const transcript = messages
    .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 500)}`)
    .join('\n\n')

  const ollamaExt = await prisma.externalModel.findFirst({
    where: { provider: 'ollama', enabled: true },
  })

  // Try Ollama first — free, local, no Claude quota
  if (ollamaExt) try {
    const res = await fetch(`${ollamaExt.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaExt.modelId,
        prompt: `Summarize this conversation in 3-5 sentences, capturing key decisions, context, and outcomes:\n\n${transcript}`,
        stream: false,
        system: 'You are a conversation summarizer. Produce a concise factual summary. Be brief.',
        options: { temperature: 0.1, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) {
      const data = await res.json() as { response?: string }
      if (data.response?.trim()) return data.response.trim()
    }
  } catch { /* Ollama unavailable — fall through to Claude */ }

  // Fallback: use Claude Code SDK (costs quota)
  try {
    if (process.env.CLAUDE_CREDENTIALS_PATH) {
      const srcCreds = path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
      const dest = '/tmp/claude-home/.claude/.credentials.json'
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (fs.existsSync(srcCreds)) fs.copyFileSync(srcCreds, dest)
    }
    const { query } = await import('@anthropic-ai/claude-code')
    const response = query({
      prompt: `Summarize this conversation concisely in 3-5 sentences, capturing key decisions, context, and outcomes:\n\n${transcript}`,
      options: { allowedTools: [], maxTurns: 1, customSystemPrompt: 'You are a conversation summarizer. Produce a concise factual summary.' },
    })
    const summary = await collectQueryText(response as AsyncIterable<unknown>)
    return summary || null
  } catch {
    return null
  }
}

export async function* streamClaudeResponse(
  prompt: string,
  conversationId: string,
  previousMessages: Array<{ role: string; content: string }> = [],
  planTarget?: { type: string; id: string } | null,
  agentSystemPrompt?: string,
  overrides?: { maxTurns?: number; allowedTools?: string[]; model?: string },
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const start = Date.now()
  const toolsUsed: string[] = []
  let totalText = ''
  const toolCallLog: Array<{ tool: string; input: string; output?: string }> = []

  try {
    const { query } = await import('@anthropic-ai/claude-code')

    // Claude Code needs a writable HOME to store state (.claude.json).
    // The Secret volume is read-only, so copy creds to /tmp and point HOME there.
    if (process.env.CLAUDE_CREDENTIALS_PATH) {
      const srcCreds = path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
      const claudeHome = '/tmp/claude-home'
      const destDir = path.join(claudeHome, '.claude')
      fs.mkdirSync(destDir, { recursive: true })
      try { fs.copyFileSync(srcCreds, path.join(destDir, '.credentials.json')) } catch { /* ignore if missing */ }
      process.env.HOME = claudeHome
    }

    const systemPrompt = agentSystemPrompt ?? (planTarget ? getPlanningSystemPrompt(planTarget.type) : getSystemPrompt())

    const fullPrompt = previousMessages.length > 0
      ? previousMessages.map(m => `${m.role}: ${m.content}`).join('\n\n') + `\n\nuser: ${prompt}`
      : prompt

    // ── Phase 1: Sonnet — gathers info with tools, produces the draft plan ─────
    const response = query({
      prompt: fullPrompt,
      options: {
        allowedTools: ALLOWED_TOOLS,
        customSystemPrompt: systemPrompt,
        maxTurns: overrides?.maxTurns ?? 20,
        ...(overrides?.allowedTools !== undefined && { allowedTools: overrides.allowedTools }),
        ...(overrides?.model && { model: overrides.model }),
      },
    })

    for await (const msg of response) {
      if (abortSignal?.aborted) break
      if (msg.type === 'assistant') {
        const assistantMsg = msg as SDKAssistantMessage
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            totalText += block.text
            yield { type: 'text', content: block.text }
          } else if (block.type === 'tool_use') {
            const toolInput = JSON.stringify(block.input)
            toolsUsed.push(`${block.name}(${toolInput})`)
            toolCallLog.push({ tool: block.name, input: toolInput })
            yield { type: 'tool_call', tool: block.name, input: toolInput }
          }
        }
      } else if (msg.type === 'user') {
        const userMsg = msg as { type: 'user'; message: { role: 'user'; content: unknown[] } }
        for (const block of userMsg.message.content as Array<{ type: string; content?: unknown }>) {
          if (block.type === 'tool_result') {
            const result = Array.isArray(block.content)
              ? (block.content as Array<{ type: string; text?: string }>).map(c => c.type === 'text' ? c.text : '').join('')
              : String(block.content ?? '')
            if (toolCallLog.length > 0) toolCallLog[toolCallLog.length - 1].output = result
            yield { type: 'tool_result', output: result }
          }
        }
      } else if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage
        const subtype = (resultMsg as { subtype?: string }).subtype
        const resultText = subtype === 'success' ? (resultMsg as { result: string }).result : undefined
        process.stderr.write(`[claude] result: subtype=${subtype} result_len=${resultText?.length ?? 0}\n`)
        if (resultText && resultText.trim() && !totalText.includes(resultText.trim())) {
          totalText += (totalText ? '\n\n' : '') + resultText
          yield { type: 'text', content: resultText }
        }
      }
    }

    // ── Phase 2 (planning only): Opus reviews the Sonnet draft ────────────────
    let opusReview = ''
    if (planTarget && totalText.trim()) {
      const separator = '\n\n---\n\n*Reviewing with Opus...*\n\n'
      yield { type: 'text', content: separator }

      const opusReviewText = await collectQueryText(query({
        prompt: `Review this draft plan and output the final, improved version. Work only from the text below — do not attempt to run any commands or gather additional information. Fill gaps, sharpen implementation steps, remove vagueness, and ensure the plan is complete and actionable. Output the final plan directly with no preamble and no open-ended questions at the end.

Draft plan to review:

${totalText}`,
        options: {
          allowedTools: [],
          customSystemPrompt: 'You are a senior technical architect. Your only job is to review and refine the draft plan provided in the prompt. Do not run any tools or commands. Do not ask for more information. Output the final plan immediately.',
          maxTurns: 1,
          model: 'claude-opus-4-6',
        },
      }))

      if (opusReviewText) {
        opusReview = opusReviewText
        yield { type: 'text', content: opusReviewText }
      }
    }

    const fullContent = opusReview
      ? `${totalText}\n\n---\n\n*Reviewing with Opus...*\n\n${opusReview}`
      : totalText
    // Cap stored content to ~1000 tokens to prevent history bloat
    const MAX_STORE_CHARS = 4000
    const savedContent = fullContent.length > MAX_STORE_CHARS
      ? fullContent.slice(0, MAX_STORE_CHARS) + '\n[…truncated for storage]'
      : fullContent

    // Save BEFORE yielding done — code after the last yield never runs because
    // the consumer breaks out of the for-await loop, calling iterator.return().
    await Promise.all([
      prisma.message.create({ data: { conversationId, role: 'user', content: prompt } }),
      prisma.message.create({ data: { conversationId, role: 'assistant', content: savedContent, ...(toolCallLog.length > 0 && { metadata: { toolCalls: toolCallLog } }) } }),
      prisma.claudeInvocation.create({
        data: { conversationId, prompt, toolsUsed, durationMs: Date.now() - start, success: true },
      }),
    ])
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.claudeInvocation.create({
      data: { conversationId, prompt, toolsUsed, durationMs: Date.now() - start, success: false },
    }).catch(() => {})
    yield { type: 'error', error: msg }
  }
}
