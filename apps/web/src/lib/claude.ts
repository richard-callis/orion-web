import fs from 'fs'
import path from 'path'
import { prisma } from './db'
import { getPrompt, interpolate } from './system-prompts'
import { generateEmbedding, vectorSearch } from './embeddings'
import type { SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-code'

async function getActiveTasksSection(): Promise<string> {
  const tasks = await prisma.task.findMany({
    where: { status: { in: ['pending', 'running'] } },
    select: { id: true, title: true, description: true, plan: true, priority: true, status: true },
    orderBy: { priority: 'desc' },
    take: 20,
  })
  if (!tasks.length) return ''
  const lines = tasks.map((t: any) =>
    `  • [${t.status}] ${t.title}${t.priority ? ` (priority: ${t.priority})` : ''}${t.description ? `\n    ${t.description.slice(0, 200)}` : ''}`
  )
  return `\nYou have a task board with active work items:\n${lines.join('\n')}\nUse these as guidance for what work is expected. Do not claim to have completed tasks you haven't verified.\n`
}

// Tool allowlist — read-only kubectl only
export const ALLOWED_TOOLS = [
  'Bash(kubectl get:*)',
  'Bash(kubectl describe:*)',
  'Bash(kubectl logs:*)',
  'Bash(kubectl top:*)',
]

function readClusterContext(): string {
  const claudeMdPath = process.env.CLAUDE_MD_PATH ?? '/claude-config/CLAUDE.md'
  try { return fs.readFileSync(claudeMdPath, 'utf8') } catch { return '# Homelab cluster — no context file mounted' }
}

async function getSystemPrompt(
  toolNames: string[] = [],
  basePrompt?: string,
  conversationId?: string,  // Optional: inject conversation memories
  knowledgeContext?: string, // Optional: pre-fetched RAG context to inject
): Promise<string> {
  const clusterContext = readClusterContext()
  const persona = basePrompt ?? 'You are ORION, an AI assistant for homelab infrastructure management.'

  // Fetch conversation memories if conversationId provided
  let memorySection = ''
  if (conversationId) {
    const memories = await prisma.memory.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    })
    if (memories.length > 0) {
      memorySection = '\n\n### CONVERSATION MEMORY (Persistent Facts)\n' +
        memories.map((m: any) => `- ${m.key}: ${m.value}${m.context ? ` (${m.context})` : ''}`).join('\n') +
        '\n\nThese facts were established earlier in this conversation. Reference them when relevant.'
    }
  }

  const kcSection = knowledgeContext
    ? '\n\n---\n## Relevant Knowledge Base\n\nThe following notes are semantically relevant to this query. Reference them when helpful:\n\n' + knowledgeContext + '\n---'
    : ''

  if (toolNames.length === 0) {
    const template = await getPrompt('system.main.no-gateway')
    return interpolate(template, { persona }) + memorySection + kcSection
  }

  const template = await getPrompt('system.main')
  return interpolate(template, {
    toolCount:      String(toolNames.length),
    toolList:       toolNames.join(', '),
    clusterContext,
  }) + memorySection + kcSection
}

async function getPlanningSystemPrompt(targetType: string): Promise<string> {
  const clusterContext = readClusterContext()
  const scope = targetType === 'epic'    ? 'high-level epic (will be broken into features)'
              : targetType === 'feature' ? 'feature (will be broken into backlog tasks)'
              :                            'task (concrete implementation steps)'
  const generateType = targetType === 'epic' ? 'features' : 'tasks'

  const template = await getPrompt('system.planning')
  return interpolate(template, { scope, generateType, clusterContext })
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
  historyMessages?: number // default 12 for agent chats (was 6)
  allowedTools?: string[]  // default [] (no tools) for agent chats
  summarizeAfter?: number  // summarize conversation after this many messages (default 15, was 20)
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
  const blocked = toolGroupMemberships.every((m: any) => {
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
  const minRequired = toolGroupMemberships.reduce((min: any, m: any) => {
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
        toolArgs: toolArgs as never,
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
  targetEnvironmentId?: string,
  systemPromptOverride?: string,
  knowledgeContext?: string,
): AsyncGenerator<StreamChunk> {
  // Load tools from the specified (or first connected) gateway
  const { GatewayClient } = await import('./agent-runner/gateway-client')
  type GatewayTool = import('./agent-runner/types').GatewayTool
  let gatewayTools: GatewayTool[] = []
  let gatewayClient: InstanceType<typeof GatewayClient> | null = null

  const connectedEnv = targetEnvironmentId
    ? await prisma.environment.findFirst({
        where: { id: targetEnvironmentId, status: 'connected', gatewayUrl: { not: null }, gatewayToken: { not: null } },
      })
    : await prisma.environment.findFirst({
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
    const sp = systemPromptOverride ?? await getSystemPrompt([], undefined, undefined, knowledgeContext)
    yield* streamOllamaAgentChat(prompt, conversationId, sp, history, model, baseUrl, undefined, abortSignal)
    return
  }

  // Tools available — run agentic loop (non-streaming turns with tool execution)
  const systemPrompt = await getSystemPrompt(gatewayTools.map(t => t.name), undefined, undefined, knowledgeContext)
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

  // Synthetic management tools — handled locally, never forwarded to the gateway
  const localToolDefs = [
    {
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
    },
    {
      type: 'function',
      function: {
        name: 'knowledge_search',
        description: 'Semantically search the knowledge base (notes, runbooks, wiki pages) for content relevant to a query.',
        parameters: {
          type: 'object',
          properties: {
            query:          { type: 'string',  description: 'Natural language search query' },
            limit:          { type: 'number',  description: 'Max results (1-20, default 5)' },
            includeContent: { type: 'boolean', description: 'Include note content (default true)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'knowledge_graph',
        description: 'Get the full knowledge graph — all notes with wikilink dependencies and semantic connections.',
        parameters: {
          type: 'object',
          properties: {
            threshold:      { type: 'number',  description: 'Min similarity for semantic edges (default 0.5)' },
            includeContent: { type: 'boolean', description: 'Include content snippet per note (default false)' },
          },
        },
      },
    },
  ]

  const ollamaToolDefs = [
    ...tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    ...localToolDefs,
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

          // Knowledge tools — handled server-side
          if (fn.name === 'knowledge_search') {
            const argsStr = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)
            yield { type: 'tool_call', tool: fn.name, input: argsStr }
            const result = await handleKnowledgeSearch(argsStr)
            yield { type: 'tool_result', tool: fn.name, output: result }
            messages.push({ role: 'tool', content: result })
            continue
          }
          if (fn.name === 'knowledge_graph') {
            const argsStr = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)
            yield { type: 'tool_call', tool: fn.name, input: argsStr }
            const result = await handleKnowledgeGraph(argsStr)
            yield { type: 'tool_result', tool: fn.name, output: result }
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
  agentId?: string,
  userId?: string,
  targetEnvironmentId?: string,
  knowledgeContext?: string,
): AsyncGenerator<StreamChunk> {
  const historyLimit   = contextConfig.historyMessages ?? 6
  const summarizeAfter = contextConfig.summarizeAfter  ?? 20
  const llm            = contextConfig.llm             ?? 'claude'

  const trimmedHistory = await maybeGetSummarizedHistory(
    conversationId, previousMessages, summarizeAfter, historyLimit
  )

  // ── Helper: load gateway tools from this agent's connected environments ────────
  // Priority: explicit @mention target > agent-linked env > STOP.
  //
  // SOC2 [A-002]: The previous "fall back to any connected environment" behaviour
  // allowed agents with no explicit gateway assignment to inherit a gateway from
  // any connected environment — exposing the gatewayToken to the LLM context and
  // enabling unauthenticated API access via the gateway's sh tool.
  // Agents must be explicitly linked to an environment to receive gateway tools.
  const loadAgentGateway = async () => {
    const { GatewayClient } = await import('./agent-runner/gateway-client')
    type GatewayTool = import('./agent-runner/types').GatewayTool

    // If user targeted a specific environment via @mention, use it directly
    let connectedEnv = targetEnvironmentId
      ? await prisma.environment.findFirst({
          where: { id: targetEnvironmentId, status: 'connected', gatewayUrl: { not: null }, gatewayToken: { not: null } },
        })
      : null

    // Try environments explicitly linked to this agent
    if (!connectedEnv && agentId) {
      connectedEnv = await prisma.environment.findFirst({
        where: {
          status: 'connected',
          gatewayUrl: { not: null },
          gatewayToken: { not: null },
          agents: { some: { agentId } },
        },
      })
    }

    // No implicit fallback — an agent without an explicit environment link gets no gateway tools.

    if (!connectedEnv?.gatewayUrl || !connectedEnv.gatewayToken) return null

    try {
      const gc = new GatewayClient(connectedEnv.gatewayUrl, connectedEnv.gatewayToken)
      const tools: GatewayTool[] = await gc.listTools()
      return tools.length ? { tools, gc, environmentId: connectedEnv.id } : null
    } catch {
      return null
    }
  }

  if (llm.startsWith('ollama:') || llm.startsWith('ext:')) {
    // Resolve model + baseUrl + provider
    let model: string = ''
    let baseUrl: string | undefined
    let timeoutSecs = 120
    let provider = 'ollama'
    let apiKey: string | undefined

    if (llm.startsWith('ext:')) {
      const extId = llm.slice('ext:'.length)
      const extModel = await prisma.externalModel.findUnique({ where: { id: extId } })
      if (!extModel) { yield { type: 'error', error: `External model not found: ${extId}` }; return }
      model = extModel.modelId || 'default'
      baseUrl = extModel.baseUrl ?? undefined
      timeoutSecs = extModel.timeoutSecs ?? 120
      provider = extModel.provider   // 'ollama' | 'openai' | 'custom' | etc.
      apiKey = extModel.apiKey ?? undefined
    } else {
      model = llm.slice('ollama:'.length)
    }

    // Load gateway tools — used by all agent backends
    const gw = await loadAgentGateway()
    const noGwSuffix = '\n\nNo MCP gateway is connected right now. You cannot run tools or commands. Be honest about this limitation.'

    const kcSection = knowledgeContext
      ? '\n\n---\n## Relevant Knowledge Base\n\n' + knowledgeContext + '\n---'
      : ''

    if (provider === 'ollama') {
      const activeTasks = await getActiveTasksSection()
      if (gw) {
        const systemPrompt = await getSystemPrompt(gw.tools.map(t => t.name), agentSystemPrompt + activeTasks, conversationId, knowledgeContext)
        yield* streamOllamaToolLoop(prompt, conversationId, systemPrompt, trimmedHistory, model, baseUrl, gw.tools, gw.gc, gw.environmentId, undefined, userId)
      } else {
        yield* streamOllamaAgentChat(prompt, conversationId, agentSystemPrompt + activeTasks + noGwSuffix + kcSection, trimmedHistory, model, baseUrl, timeoutSecs)
      }
    } else {
      // OpenAI-compatible endpoint (custom / openai / llama.cpp / etc.)
      // Don't use getSystemPrompt — its ORION template would conflict with the agent's persona.
      // agentSystemPrompt is already the raw agent identity prompt.
      const activeTasks = await getActiveTasksSection()
      let openAISystemPrompt: string
      if (gw) {
        // Build system prompt: persona + tasks + tool definitions + cluster context
        const toolDefs = gw.tools.map(t => `  - ${t.name}: ${t.description || 'No description'}`).join('\n')
        openAISystemPrompt = `${agentSystemPrompt}${activeTasks}

You have the following MCP tools available:
${toolDefs}

Tool usage rules:
- Call tools immediately when you need real data. Do not ask permission first.
- NEVER make up or hallucinate tool output. Always use a tool and return its real result.

${readClusterContext()}${kcSection}`
      } else {
        openAISystemPrompt = agentSystemPrompt + activeTasks + noGwSuffix + kcSection
      }
      yield* streamOpenAIChatCore(
        prompt, conversationId, openAISystemPrompt, trimmedHistory,
        model!, baseUrl!, apiKey,
        gw?.tools ?? [], gw?.gc ?? null, gw?.environmentId,
        undefined, userId,
      )
    }
    return
  }

  if (llm.startsWith('gemini:')) {
    const model = llm.slice('gemini:'.length)
    yield* streamGeminiAgentChat(prompt, conversationId, agentSystemPrompt, trimmedHistory, model)
    return
  }

  // Claude path — claude:<model-id> or bare 'claude' (default)
  const claudeModel  = llm.startsWith('claude:') ? llm.slice('claude:'.length) : undefined
  const maxTurns     = contextConfig.maxTurns    ?? 6
  const allowedTools = contextConfig.allowedTools ?? []

  const kcSectionClaude = knowledgeContext
    ? '\n\n---\n## Relevant Knowledge Base\n\n' + knowledgeContext + '\n---'
    : ''

  const overridePrompt = `You are NOT Claude Code and NOT the Claude CLI. Do not mention or reference Claude Code, Anthropic's CLI, or any developer tooling.

${agentSystemPrompt}

Respond only in the persona described above. Never break character or refer to yourself as Claude Code.${kcSectionClaude}`

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

// ── OpenAI-compatible chat (custom / openai providers) ────────────────────────

export async function* streamOpenAIChat(
  prompt: string,
  conversationId: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  baseUrl: string,
  apiKey?: string,
  abortSignal?: AbortSignal,
  userId?: string,
  targetEnvironmentId?: string,
  systemPromptOverride?: string,
  knowledgeContext?: string,
): AsyncGenerator<StreamChunk> {
  // Load gateway tools from specified or first connected environment
  const { GatewayClient } = await import('./agent-runner/gateway-client')
  type GatewayTool = import('./agent-runner/types').GatewayTool
  let gatewayTools: GatewayTool[] = []
  let gatewayClient: InstanceType<typeof GatewayClient> | null = null

  const connectedEnv = targetEnvironmentId
    ? await prisma.environment.findFirst({
        where: { id: targetEnvironmentId, status: 'connected', gatewayUrl: { not: null }, gatewayToken: { not: null } },
      })
    : await prisma.environment.findFirst({
        where: { status: 'connected', gatewayUrl: { not: null }, gatewayToken: { not: null } },
      })
  if (connectedEnv?.gatewayUrl && connectedEnv.gatewayToken) {
    gatewayClient = new GatewayClient(connectedEnv.gatewayUrl, connectedEnv.gatewayToken)
    try { gatewayTools = await gatewayClient.listTools() } catch { /* proceed without tools */ }
  }

  const systemPrompt = systemPromptOverride ?? await getSystemPrompt(gatewayTools.map(t => t.name), undefined, conversationId, knowledgeContext)
  yield* streamOpenAIChatCore(
    prompt, conversationId, systemPrompt, history,
    model, baseUrl, apiKey,
    gatewayTools.length ? gatewayTools : [],
    gatewayTools.length ? gatewayClient : null,
    connectedEnv?.id,
    abortSignal, userId,
  )
}

// ── Management tool handlers ──────────────────────────────────────────────────

async function handleProposeTool(argsRaw: string, environmentId: string | undefined, conversationId: string): Promise<string> {
  try {
    const args = JSON.parse(argsRaw || '{}') as {
      name?: string; description?: string; inputSchema?: object;
      execType?: string; execConfig?: object
    }
    if (!args.name || !args.description || !args.inputSchema) {
      return 'Error: propose_tool requires name, description, and inputSchema'
    }
    if (!environmentId) return 'Error: no environment context — cannot propose a tool'

    const existing = await prisma.mcpTool.findFirst({
      where: { environmentId, name: args.name },
    })
    if (existing) {
      return `Tool "${args.name}" already exists (status: ${existing.status}).`
    }

    await prisma.mcpTool.create({
      data: {
        environmentId,
        name:        args.name,
        description: args.description,
        inputSchema: args.inputSchema as object,
        execType:    (args.execType as string) || 'shell',
        execConfig:  args.execConfig as object | undefined,
        enabled:     false,
        builtIn:     false,
        status:      'pending',
        proposedBy:  conversationId,
        proposedAt:  new Date(),
      },
    })

    return `Tool "${args.name}" proposed successfully. An admin will review and approve it from Administration → Environments → Approvals.`
  } catch (e) {
    return `Error proposing tool: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function handleOrionGetEnvironment(argsRaw: string): Promise<string> {
  try {
    const { environment_id } = JSON.parse(argsRaw || '{}') as { environment_id?: string }
    if (!environment_id) return 'Error: environment_id is required'
    const env = await prisma.environment.findFirst({
      where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
    })
    if (!env) return `Error: environment "${environment_id}" not found`
    return JSON.stringify({
      id:          env.id,
      name:        env.name,
      type:        env.type,
      status:      env.status,
      gatewayUrl:  env.gatewayUrl,
      kubeconfig:  env.kubeconfig ? '••••' : null,
      gitOwner:  env.gitOwner,
      gitRepo:   env.gitRepo,
    }, null, 2)
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function handleOrionPatchEnvironment(argsRaw: string): Promise<string> {
  try {
    const { environment_id, body } = JSON.parse(argsRaw || '{}') as { environment_id?: string; body?: Record<string, unknown> }
    if (!environment_id) return 'Error: environment_id is required'
    if (!body || typeof body !== 'object') return 'Error: body must be an object'

    // Only allow safe fields to be patched
    const ALLOWED = ['kubeconfig', 'gatewayUrl', 'gitOwner', 'gitRepo', 'description']
    const update: Record<string, unknown> = {}
    for (const key of ALLOWED) {
      if (key in body) update[key] = body[key]
    }
    if (!Object.keys(update).length) return 'Error: no patchable fields provided'

    const target = await prisma.environment.findFirst({
      where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
    })
    if (!target) return `Error: environment "${environment_id}" not found`
    await prisma.environment.update({ where: { id: target.id }, data: update })
    return `Environment "${target.name}" updated: ${Object.keys(update).join(', ')}`
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function handleOrionBootstrapEnvironment(argsRaw: string): Promise<string> {
  try {
    const { environment_id } = JSON.parse(argsRaw || '{}') as { environment_id?: string }
    if (!environment_id) return 'Error: environment_id is required'

    const env = await prisma.environment.findFirst({
      where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
    })
    if (!env) return `Error: environment "${environment_id}" not found`
    if (!env.kubeconfig) return 'Error: no kubeconfig stored for this environment. Patch it first using orion_patch_environment.'

    // Call the bootstrap endpoint internally
    const baseUrl = process.env.ORION_CALLBACK_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
    const res = await fetch(`${baseUrl}/api/environments/${environment_id}/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-call': '1' },
    })
    if (!res.ok) return `Bootstrap request failed: HTTP ${res.status}`

    // Collect SSE stream output
    const reader = res.body?.getReader()
    if (!reader) return 'Bootstrap started (no stream output)'
    const decoder = new TextDecoder()
    const lines: string[] = []
    let done = false
    while (!done) {
      const { value, done: d } = await reader.read()
      done = d
      if (value) {
        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6)) as { type: string; message?: string }
            if (evt.message) lines.push(`[${evt.type}] ${evt.message}`)
          } catch { /* skip */ }
        }
      }
    }
    return lines.length ? lines.join('\n') : 'Bootstrap completed (no output captured)'
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function handleGitopsPropose(argsRaw: string, conversationId: string): Promise<string> {
  try {
    const args = JSON.parse(argsRaw || '{}') as {
      environment_id?: string
      title?: string
      reasoning?: string
      operation_description?: string
      changes?: Array<{ path: string; content: string }>
    }

    if (!args.environment_id || !args.title || !args.reasoning || !args.operation_description || !args.changes?.length) {
      return 'Error: environment_id, title, reasoning, operation_description, and changes are all required'
    }

    const { proposeChange } = await import('./gitops')
    // Accept either the CUID or the environment name
    const env = await prisma.environment.findFirst({
      where: { OR: [{ id: args.environment_id }, { name: { equals: args.environment_id, mode: 'insensitive' } }] },
    })
    if (!env) return `Error: environment "${args.environment_id}" not found`
    if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo — run bootstrap first'

    const policy = (env.policyConfig ?? {}) as import('./gitops-policy').PolicyConfig
    const result = await proposeChange({
      owner: env.gitOwner,
      repo:  env.gitRepo,
      title: args.title,
      reasoning: args.reasoning,
      operationDescription: args.operation_description,
      changes: args.changes,
      policy,
    })

    await prisma.gitOpsPR.create({
      data: {
        environmentId: args.environment_id,
        prNumber:  result.prNumber,
        title:     args.title,
        operation: result.classification.operation,
        decision:  result.classification.decision,
        status:    result.merged ? 'merged' : 'open',
        prUrl:     result.prUrl,
        reasoning: args.reasoning,
        branch:    result.branch,
        mergedAt:  result.merged ? new Date() : null,
      },
    })

    const action = result.merged
      ? `auto-merged (${result.classification.reason})`
      : `opened for review — ${result.classification.reason}`
    return `PR #${result.prNumber} ${action}. URL: ${result.prUrl}`
  } catch (e) {
    return `Error proposing GitOps change: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ── Knowledge graph management tool handlers ─────────────────────────────────

async function handleKnowledgeSearch(argsRaw: string): Promise<string> {
  try {
    const { query, limit = 5, includeContent = true } = JSON.parse(argsRaw || '{}') as {
      query?: string; limit?: number; includeContent?: boolean
    }
    if (!query) return 'Error: query is required'

    const embedding = await generateEmbedding(query.slice(0, 2000))
    if (!embedding) return 'No embedding provider configured. Add an embedding model in Admin → Models to enable semantic search.'

    const results = await vectorSearch(embedding.vector, Math.min(limit, 20))
    if (!results.length) return 'No relevant notes found for this query.'

    return JSON.stringify(
      results.map(r => ({
        title:  r.title,
        type:   r.type,
        folder: r.folder,
        score:  parseFloat(r.score.toFixed(3)),
        ...(includeContent && { content: r.content.slice(0, 2000) }),
      })),
      null, 2
    )
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function handleKnowledgeGraph(argsRaw: string): Promise<string> {
  try {
    const { threshold = 0.5, includeContent = false } = JSON.parse(argsRaw || '{}') as {
      threshold?: number; includeContent?: boolean
    }

    const [notes, semanticEdges] = await Promise.all([
      prisma.note.findMany({
        select: { id: true, title: true, type: true, folder: true, content: true },
        orderBy: { title: 'asc' },
      }),
      prisma.semanticConnection.findMany({
        where: { score: { gte: threshold } },
        select: { sourceNoteId: true, targetNoteId: true, score: true },
        orderBy: { score: 'desc' },
        take: 200,
      }),
    ])

    const noteById = new Map(notes.map((n: any) => [n.id, n]))

    // Parse wikilinks from note content
    const wikilinkEdges: Array<{ from: string; to: string }> = []
    const noteByTitle = new Map(notes.map((n: any) => [n.title.toLowerCase(), n.title]))
    const wikilinkRegex = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g
    for (const note of notes) {
      for (const match of note.content.matchAll(wikilinkRegex)) {
        const target = match[1].trim()
        if (noteByTitle.has(target.toLowerCase()) && target.toLowerCase() !== note.title.toLowerCase()) {
          wikilinkEdges.push({ from: note.title, to: target })
        }
      }
    }

    const nodeLines = notes.map((n: any) => {
      const tag = n.type !== 'note' ? ` [${n.type}]` : ''
      const folder = n.folder ? ` (${n.folder})` : ''
      const snippet = includeContent ? `\n  ${n.content.slice(0, 200).replace(/\n/g, ' ')}` : ''
      return `- ${n.title}${tag}${folder}${snippet}`
    })

    const wikiLines = wikilinkEdges.map((e: any) => `  ${e.from} → ${e.to}`)
    const semLines = semanticEdges
      .map((e: any) => {
        const src = (noteById.get(e.sourceNoteId) as any)?.title ?? e.sourceNoteId
        const tgt = (noteById.get(e.targetNoteId) as any)?.title ?? e.targetNoteId
        return `  ${src} ↔ ${tgt} (${(e.score * 100).toFixed(0)}%)`
      })

    let output = `Knowledge Graph — ${notes.length} notes\n\n## Notes\n${nodeLines.join('\n')}`
    if (wikiLines.length) output += `\n\n## Wikilink Dependencies\n${wikiLines.join('\n')}`
    if (semLines.length)  output += `\n\n## Semantic Connections (≥${(threshold * 100).toFixed(0)}% similar)\n${semLines.join('\n')}`
    return output
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function* streamOpenAIChatCore(
  prompt: string,
  conversationId: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  baseUrl: string,
  apiKey: string | undefined,
  tools: import('./agent-runner/types').GatewayTool[],
  gateway: import('./agent-runner/gateway-client').GatewayClient | null,
  environmentId: string | undefined,
  abortSignal?: AbortSignal,
  userId?: string,
): AsyncGenerator<StreamChunk> {
  const start = Date.now()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  // Management tools — always available, executed server-side by ORION (not the gateway)
  const MANAGEMENT_TOOLS = [
    {
      type: 'function' as const,
      function: {
        name: 'propose_tool',
        description: 'Propose a new MCP tool for admin review. Use this when you need a capability that isn\'t in your current tool list. The admin will be notified to approve or reject the proposal.',
        parameters: {
          type: 'object',
          properties: {
            name:        { type: 'string', description: 'snake_case tool name' },
            description: { type: 'string', description: 'Clear one-sentence description of what the tool does' },
            inputSchema: {
              type: 'object',
              description: 'JSON Schema for the tool inputs (type: object, properties, required)',
            },
            execType:   { type: 'string', enum: ['shell', 'http', 'builtin'], description: 'How the tool is executed' },
            execConfig: { type: 'object', description: 'Execution config: shell={command}, http={url,method}' },
          },
          required: ['name', 'description', 'inputSchema'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'orion_get_environment',
        description: 'Get the configuration and status of an ORION environment, including whether kubeconfig is stored.',
        parameters: {
          type: 'object',
          properties: {
            environment_id: { type: 'string', description: 'Environment ID' },
          },
          required: ['environment_id'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'orion_patch_environment',
        description: 'Update fields on an ORION environment (e.g. save kubeconfig, update gatewayUrl).',
        parameters: {
          type: 'object',
          properties: {
            environment_id: { type: 'string', description: 'Environment ID' },
            body:           { type: 'object', description: 'Fields to update, e.g. {"kubeconfig": "<base64>"}' },
          },
          required: ['environment_id', 'body'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'orion_bootstrap_environment',
        description: 'Trigger the bootstrap process for a Kubernetes cluster environment. Deploys ArgoCD and ORION Gateway into the cluster.',
        parameters: {
          type: 'object',
          properties: {
            environment_id: { type: 'string', description: 'Environment ID' },
          },
          required: ['environment_id'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'knowledge_search',
        description: 'Semantically search the knowledge base (notes, runbooks, wiki pages) for content relevant to a query. Returns notes ranked by similarity.',
        parameters: {
          type: 'object',
          properties: {
            query:          { type: 'string',  description: 'Natural language search query' },
            limit:          { type: 'number',  description: 'Max results to return (1-20, default 5)' },
            includeContent: { type: 'boolean', description: 'Whether to include full note content (default true)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'knowledge_graph',
        description: 'Get the full knowledge graph — all notes with their types, wikilink dependencies, and semantic connections. Use this to understand what documentation exists and how topics relate to each other.',
        parameters: {
          type: 'object',
          properties: {
            threshold:      { type: 'number',  description: 'Minimum similarity score for semantic edges (0.0-1.0, default 0.5)' },
            includeContent: { type: 'boolean', description: 'Include a short content snippet per note (default false)' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'gitops_propose',
        description: `Propose a GitOps change for a localhost/docker environment. Creates a branch, commits the files, opens a PR, and auto-merges if policy allows.

RULES FOR DOCKER COMPOSE FILES (critical — violations cause deployment failures):
1. SELF-CONTAINED ONLY. Do NOT use bind mounts for config files (volumes: ./nginx.conf:/etc/nginx/nginx.conf). The CI runner checks out the repo into a volume, not a normal filesystem path — bind mounts to host files fail with "not a directory".
2. Use environment variables, command args, or inline config via 'command:' instead of mounted config files.
3. If config is needed, write it via 'entrypoint' with a shell heredoc, or use a pre-configured image.
4. Named volumes (no host path) are fine: volumes: [data:/data]
5. Always use a pinned image tag (e.g. nginx:1.27.1) not 'latest' unless explicitly requested.
6. Services path: services/<service-name>/docker-compose.yml`,
        parameters: {
          type: 'object',
          properties: {
            environment_id:       { type: 'string', description: 'Environment ID or name to deploy to (e.g. "localhost", "production")' },
            title:                { type: 'string', description: 'Short PR title, e.g. "feat: add nginx reverse proxy"' },
            reasoning:            { type: 'string', description: 'Why this change is needed' },
            operation_description:{ type: 'string', description: 'Plain-language summary for policy classification: e.g. "add new service", "update image tag to patch version", "scale replicas", "remove service"' },
            changes: {
              type: 'array',
              description: 'Files to create or update. Each docker-compose.yml must be fully self-contained with no host bind mounts.',
              items: {
                type: 'object',
                properties: {
                  path:    { type: 'string', description: 'Repo-relative file path, e.g. services/nginx/docker-compose.yml' },
                  content: { type: 'string', description: 'Full file content' },
                },
                required: ['path', 'content'],
              },
            },
          },
          required: ['environment_id', 'title', 'reasoning', 'operation_description', 'changes'],
        },
      },
    },
  ]

  // OpenAI tool schema format
  const openaiTools = [
    ...MANAGEMENT_TOOLS,
    ...tools.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
  ]

  type OAIMessage = { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }
  const messages: OAIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    { role: 'user', content: prompt },
  ]

  let totalText = ''
  const toolsUsed: string[] = []
  const toolCallLog: Array<{ tool: string; input: string; output?: string }> = []

  try {
    // Agentic loop — handles tool calls until model returns a final text response
    for (let turn = 0; turn < 10; turn++) {
      const body: Record<string, unknown> = { model, messages, stream: true }
      if (openaiTools.length) body.tools = openaiTools

      const timeoutSignal = AbortSignal.timeout(120_000)
      const fetchSignal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: fetchSignal,
      })
      if (!res.ok) throw new Error(`OpenAI-compatible API ${res.status}: ${await res.text()}`)
      if (!res.body) throw new Error('No response body')

      // Parse SSE stream
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let turnText = ''
      const pendingToolCalls: Array<{ id: string; name: string; argsRaw: string }> = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string
                  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
                }
                finish_reason?: string
              }>
            }
            const delta = chunk.choices?.[0]?.delta
            if (!delta) continue

            // Accumulate text
            if (delta.content) {
              turnText += delta.content
              totalText += delta.content
              yield { type: 'text', content: delta.content }
            }

            // Accumulate tool call fragments
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index
                if (!pendingToolCalls[idx]) {
                  pendingToolCalls[idx] = { id: tc.id ?? `tc_${idx}`, name: tc.function?.name ?? '', argsRaw: '' }
                }
                if (tc.function?.name) pendingToolCalls[idx].name = tc.function.name
                if (tc.function?.arguments) pendingToolCalls[idx].argsRaw += tc.function.arguments
              }
            }
          } catch { /* skip malformed chunk */ }
        }
      }

      // If no tool calls, we're done
      if (!pendingToolCalls.length) break

      // Execute tool calls
      const assistantToolCalls = pendingToolCalls.map(tc => ({
        id: tc.id, type: 'function' as const,
        function: { name: tc.name, arguments: tc.argsRaw },
      }))
      messages.push({ role: 'assistant', content: turnText, tool_calls: assistantToolCalls })

      for (const tc of pendingToolCalls) {
        yield { type: 'tool_call', tool: tc.name, input: tc.argsRaw }
        toolsUsed.push(tc.name)

        let result: string

        // ── Management tools — handled server-side by ORION ──────────────────
        if (tc.name === 'propose_tool') {
          result = await handleProposeTool(tc.argsRaw, environmentId, conversationId)
        } else if (tc.name === 'orion_get_environment') {
          result = await handleOrionGetEnvironment(tc.argsRaw)
        } else if (tc.name === 'orion_patch_environment') {
          result = await handleOrionPatchEnvironment(tc.argsRaw)
        } else if (tc.name === 'orion_bootstrap_environment') {
          result = await handleOrionBootstrapEnvironment(tc.argsRaw)
        } else if (tc.name === 'gitops_propose') {
          result = await handleGitopsPropose(tc.argsRaw, conversationId)
        } else if (tc.name === 'knowledge_search') {
          result = await handleKnowledgeSearch(tc.argsRaw)
        } else if (tc.name === 'knowledge_graph') {
          result = await handleKnowledgeGraph(tc.argsRaw)
        } else if (gateway && environmentId) {
          // ── Gateway tools ─────────────────────────────────────────────────
          try {
            const args = JSON.parse(tc.argsRaw || '{}') as Record<string, unknown>
            const perm = await checkToolPermission(tc.name, args, environmentId, conversationId, userId)
            if (!perm.allowed) {
              result = `Permission denied: ${perm.reason}`
            } else {
              result = await gateway.executeTool(tc.name, args)
            }
          } catch (e) {
            result = `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        } else {
          result = 'No gateway connected'
        }

        toolCallLog.push({ tool: tc.name, input: tc.argsRaw, output: result })
        yield { type: 'tool_result', tool: tc.name, output: result }
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
      }
    }

    const MAX_STORE = 4000
    const savedContent = totalText.length > MAX_STORE
      ? totalText.slice(0, MAX_STORE) + '\n[…truncated for storage]'
      : totalText

    await Promise.all([
      prisma.message.create({ data: { conversationId, role: 'user', content: prompt } }),
      prisma.message.create({
        data: {
          conversationId,
          role: 'assistant',
          content: savedContent,
          metadata: toolCallLog.length ? ({ toolCalls: toolCallLog } as any) : undefined,
        },
      }),
      prisma.claudeInvocation.create({
        data: { conversationId, prompt, toolsUsed, durationMs: Date.now() - start, success: true },
      }),
    ])
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.claudeInvocation.create({
      data: { conversationId, prompt, toolsUsed: [], durationMs: Date.now() - start, success: false },
    }).catch(() => {})
    yield { type: 'error', error: `OpenAI API error: ${msg}` }
  }
}

export async function* streamGeminiChat(
  prompt: string,
  conversationId: string,
  history: Array<{ role: string; content: string }>,
  model: string,
  abortSignal?: AbortSignal,
  knowledgeContext?: string,
): AsyncGenerator<StreamChunk> {
  const sp = await getSystemPrompt([], undefined, undefined, knowledgeContext)
  yield* streamGeminiAgentChat(prompt, conversationId, sp, history, model, abortSignal)
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
          } as any,
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
  // Increased from 500 to 1000 chars to capture more context in the summary
  const transcript = messages
    .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 1000)}`)
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
        prompt: `Create a detailed conversation summary that captures:
- Key facts discovered or established (names, values, configurations)
- Decisions made and the reasoning behind them
- Important context about systems, services, or state
- Any pending items or unresolved questions

Be specific with details. Use 5-8 sentences if needed for completeness:

${transcript}`,
        stream: false,
        system: 'You are a conversation summarizer. Produce a detailed factual summary that preserves important context and facts.',
        options: { temperature: 0.1, num_predict: 500 },
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
      prompt: `Create a detailed conversation summary that captures:
- Key facts discovered or established (names, values, configurations)
- Decisions made and the reasoning behind them
- Important context about systems, services, or state
- Any pending items or unresolved questions

Be specific with details. Use 5-8 sentences if needed for completeness:

${transcript}`,
      options: { allowedTools: [], maxTurns: 1, customSystemPrompt: 'You are a conversation summarizer. Produce a detailed factual summary that preserves important context and facts.' },
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
  knowledgeContext?: string,
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

    const baseSystemPrompt = agentSystemPrompt ?? (planTarget
      ? await getPlanningSystemPrompt(planTarget.type)
      : await getSystemPrompt([], undefined, conversationId, knowledgeContext))
    const systemPrompt = agentSystemPrompt && knowledgeContext
      ? agentSystemPrompt + '\n\n---\n## Relevant Knowledge Base\n\n' + knowledgeContext + '\n---'
      : baseSystemPrompt

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
          customSystemPrompt: await getPrompt('system.plan-review'),
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
      prisma.message.create({ data: { conversationId, role: 'assistant', content: savedContent, ...(toolCallLog.length > 0 && { metadata: { toolCalls: toolCallLog } } as any) } }),
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
