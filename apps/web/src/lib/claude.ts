/**
 * Human chat entry points (the /api/chat/conversations/:id/stream SSE route).
 *
 * Every provider path is a thin caller of the shared LLM engine
 * (lib/agent-runner/engine): this file only picks the provider, builds the
 * system prompt / history / tool list, and hands the run to the chat glue in
 * lib/agent-runner/chat.ts (tool policy, tracing, persistence, StreamChunks).
 */
import fs from 'fs'
import type { Prisma } from '@prisma/client'
import { humanActor } from './gateway-headers'
import { prisma } from './db'
import { getPrompt, interpolate } from './system-prompts'
import { generateEmbedding, skillVectorSearch } from './embeddings'
import { getChatUserRole, canUseTools, filterToolsForRole } from './chat-tool-policy'
import { resolveModel, DEFAULT_ROLE_MODELS, type ModelRole } from './model-roles'
import { beginBudgetedRun, getRunTokenCap, RunTokenCap } from './llm-budget'
import { estimateTokens } from './token-budget'
import type { SkillSpec } from './skill-tools'
import { GatewayClient } from './agent-runner/gateway-client'
import type { GatewayTool } from './agent-runner/types'
import {
  ChatRun, buildFullContextSnapshot, chatMessages, streamChatLoop, streamPlainChat, registryChatToolSpecs, dedupeTools,
  type StreamChunk, type ChatHistory, type ToolCallLogEntry,
} from './agent-runner/chat'
import { createOpenAIProvider } from './agent-runner/engine/providers/openai'
import { createOllamaProvider, buildOllamaOptions } from './agent-runner/engine/providers/ollama'
import { createGeminiProvider } from './agent-runner/engine/providers/gemini'
import { sidecarStream, sidecarCollect } from './agent-runner/engine/providers/claude-sidecar'
import { completeOnce } from './agent-runner/engine/complete'
import type { ToolSpec } from './agent-runner/engine/types'

export type { StreamChunk } from './agent-runner/chat'

// ── Skill Injection: match a query against installed skills ────────────────────
// Shared across every path that surfaces skills automatically (rather than an
// agent explicitly calling use_skill): direct/agent-target AI chat here, task
// execution (worker.ts), and chat-room replies (room-agents.ts).
//
// Two-stage match: exact substring against triggerPatterns first (cheap,
// deterministic, no embedding call), then — only if that misses — semantic
// similarity against the skill's embedded meaning (name + description +
// trigger patterns, see embedSkill in embeddings.ts), so a message that
// describes the same situation in different words still surfaces the skill.
// The semantic threshold is intentionally strict: a wrong skill's
// instructions actively mislead the agent, which is worse than no match.
//
// 0.55 was chosen back when skillVectorSearch used pgvector's `<->` (L2)
// operator, so `1 - distance` was NOT a true cosine similarity and this
// value was uncalibrated against any bounded metric. Now that
// skillVectorSearch uses `<=>` (cosine distance) like vectorSearch, `score`
// is a real cosine similarity in [0, 1]. For short "name + description +
// trigger patterns" embeddings, on-topic pairs typically land ~0.6-0.85 and
// unrelated pairs ~0.1-0.35, so 0.55 still sits on the strict side of that
// gap and remains a reasonable threshold post-fix.
const SEMANTIC_SKILL_MATCH_MIN_SCORE = 0.55

// Request-scoped cache of in-flight/completed embedding calls, keyed by the
// exact (already-truncated) text passed to generateEmbedding. Callers that
// process the same message text multiple times within one logical
// request/turn (e.g. room-agents.ts replying with several agents to the same
// triggering message) can share a cache instance across their
// matchAndInjectSkills calls so the text is embedded at most once — never a
// cross-request or cross-message cache, just de-duplication within a turn.
export type SkillEmbedCache = Map<string, ReturnType<typeof generateEmbedding>>

function getCachedEmbedding(text: string, cache?: SkillEmbedCache): ReturnType<typeof generateEmbedding> {
  if (!cache) return generateEmbedding(text)
  let pending = cache.get(text)
  if (!pending) {
    pending = generateEmbedding(text)
    cache.set(text, pending)
  }
  return pending
}

export async function matchAndInjectSkills(
  environmentId: string,
  message: string,
  logSource: 'chat_match' | 'task_match' | 'room_match' = 'chat_match',
  contextId?: string,
  embedCache?: SkillEmbedCache,
): Promise<{ injected: string; skillName: string | null }> {
  const skills = await prisma.nebulaInstance.findMany({
    where: { environmentId, category: 'skill', isInstalled: true },
  })
  const msgLower = message.toLowerCase()

  // Stage 1: exact substring match
  for (const skill of skills) {
    let spec: SkillSpec
    try { spec = JSON.parse(skill.spec) as SkillSpec } catch { continue }
    if (!spec?.triggerPatterns?.length) continue
    const matched = spec.triggerPatterns.find(p => msgLower.includes(p.toLowerCase()))
    if (matched) {
      // Non-blocking log — failures must not break the calling flow
      prisma.skillExecutionLog.create({
        data: { nebulaId: skill.id, source: logSource, matchedPattern: matched, contextId: contextId ?? null },
      }).catch(() => {})
      return { injected: spec.systemPrompt ?? '', skillName: skill.name }
    }
  }

  // Stage 2: semantic fallback — only against skills with an embedding
  // (embedSkill is called at write time by save_skill, Dream, and the Nebula
  // UI's skill-create route; older skills without one are simply excluded).
  // Skip entirely if this environment has no skills at all — no point paying
  // for an embedding-provider call on every turn when there's nothing to match.
  if (skills.length === 0) return { injected: '', skillName: null }
  // Cheap pre-check: skip the embedding-provider call (real latency/cost, up
  // to a 30s timeout) entirely when none of this environment's installed
  // skills actually have a stored embedding to match against — a single
  // indexed existence query beats paying for an API call with no chance of
  // a hit. Net result is unchanged: previously an unmatched embedding call
  // would just fall through to skillVectorSearch returning no rows.
  const hasEmbeddedSkill = await prisma.nebulaEmbedding.findFirst({
    where: { nebulaId: { in: skills.map(s => s.id) } },
    select: { nebulaId: true },
  })
  if (!hasEmbeddedSkill) return { injected: '', skillName: null }
  try {
    const embedResult = await getCachedEmbedding(message.slice(0, 2000), embedCache)
    if (embedResult) {
      const [best] = await skillVectorSearch(embedResult.vector, embedResult.modelRef, environmentId, 1)
      if (best && best.score >= SEMANTIC_SKILL_MATCH_MIN_SCORE) {
        const skill = await prisma.nebulaInstance.findUnique({ where: { id: best.nebulaId } })
        if (skill) {
          let spec: SkillSpec = {}
          try { spec = JSON.parse(skill.spec) as SkillSpec } catch { /* corrupted spec — skip */ }
          if (spec.systemPrompt) {
            prisma.skillExecutionLog.create({
              data: {
                nebulaId: skill.id,
                source: logSource,
                matchedPattern: `semantic:${best.score.toFixed(2)}`,
                contextId: contextId ?? null,
              },
            }).catch(() => {})
            return { injected: spec.systemPrompt, skillName: skill.name }
          }
        }
      }
    }
  } catch (e) {
    console.error('[skills] Semantic match failed (non-fatal):', e)
  }

  return { injected: '', skillName: null }
}

async function getActiveTasksSection(): Promise<string> {
  const tasks = await prisma.task.findMany({
    where: { status: { in: ['pending', 'running'] } },
    select: { id: true, title: true, description: true, plan: true, priority: true, status: true },
    orderBy: { priority: 'desc' },
    take: 20,
  })
  if (!tasks.length) return ''
  const lines = tasks.map(t =>
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

/**
 * System prompt split for prompt caching: `stable` (template / persona) is
 * identical across turns; `volatile` (conversation memories, RAG notes)
 * changes per turn. stable + volatile is the full prompt.
 */
interface SystemPromptParts { stable: string; volatile: string }

async function getSystemPromptParts(
  toolNames: string[] = [],
  basePrompt?: string,
  conversationId?: string,  // Optional: inject conversation memories
  knowledgeContext?: string, // Optional: pre-fetched RAG context to inject
): Promise<SystemPromptParts> {
  const persona = basePrompt ?? 'You are ORION, an AI assistant for homelab infrastructure management.'

  let memorySection = ''
  if (conversationId) {
    const memories = await prisma.memory.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } })
    if (memories.length > 0) {
      memorySection = '\n\n### CONVERSATION MEMORY (Persistent Facts)\n' +
        memories.map(m => `- ${m.key}: ${m.value}${m.context ? ` (${m.context})` : ''}`).join('\n') +
        '\n\nThese facts were established earlier in this conversation. Reference them when relevant.'
    }
  }

  const kcSection = knowledgeContext
    ? '\n\n---\n## Relevant Knowledge Base\n\nThe following notes are semantically relevant to this query. Reference them when helpful:\n\n' + knowledgeContext + '\n---'
    : ''

  const stable = toolNames.length === 0
    ? interpolate(await getPrompt('system.main.no-gateway'), { persona })
    : interpolate(await getPrompt('system.main'), {
        toolCount:      String(toolNames.length),
        toolList:       toolNames.join(', '),
        clusterContext: readClusterContext(),
      })
  return { stable, volatile: memorySection + kcSection }
}

async function getSystemPrompt(
  toolNames: string[] = [],
  basePrompt?: string,
  conversationId?: string,
  knowledgeContext?: string,
): Promise<string> {
  const { stable, volatile } = await getSystemPromptParts(toolNames, basePrompt, conversationId, knowledgeContext)
  return stable + volatile
}

async function getPlanningSystemPrompt(targetType: string): Promise<string> {
  const scope = targetType === 'epic'    ? 'high-level epic (will be broken into features)'
              : targetType === 'feature' ? 'feature (will be broken into backlog tasks)'
              :                            'task (concrete implementation steps)'
  const generateType = targetType === 'epic' ? 'features' : 'tasks'
  return interpolate(await getPrompt('system.planning'), { scope, generateType, clusterContext: readClusterContext() })
}

export interface AgentContextConfig {
  maxTurns?: number        // default 6 for agent chats
  historyMessages?: number // default 12 for agent chats (was 6)
  allowedTools?: string[]  // default [] (no tools) for agent chats
  summarizeAfter?: number  // summarize conversation after this many messages (default 15, was 20)
  llm?: string             // "claude:<model-id>" | "ollama:<model-id>" | "gemini:<model-id>" | "ext:<cuid>" — defaults to Claude Sonnet

  // Ring Leader delegation fields
  discoverable?: boolean           // when true, this agent can be discovered by findSpecialist
  maxParallelDelegations?: number  // default 3
  canWriteKnowledge?: boolean      // default false
  knowledgeScope?: "global" | "room" | "agent-local"  // default "global"
}

// ── Gateway resolution for chat ───────────────────────────────────────────────

interface ChatGateway {
  client: GatewayClient
  tools: GatewayTool[]
  environmentId: string
}

/**
 * The gateway a chat may use: the targeted environment, else the first
 * connected one. readonly/anonymous users never get a gateway (no tools).
 * An unreachable gateway yields an empty tool list.
 */
async function connectChatGateway(userId: string | undefined, targetEnvironmentId: string | undefined): Promise<ChatGateway | null> {
  if (!canUseTools(await getChatUserRole(userId))) return null
  const env = await prisma.environment.findFirst({
    where: {
      ...(targetEnvironmentId && { id: targetEnvironmentId }),
      status: 'connected', gatewayUrl: { not: null }, gatewayToken: { not: null },
    },
  })
  if (!env?.gatewayUrl || !env.gatewayToken) return null
  const client = new GatewayClient(env.gatewayUrl, env.gatewayToken, humanActor(userId))
  const tools = await client.listTools().catch((): GatewayTool[] => [])
  return { client, tools, environmentId: env.id }
}

const toSpec = (t: GatewayTool): ToolSpec => ({ name: t.name, description: t.description, parameters: t.inputSchema })

// ── Ollama chat ──────────────────────────────────────────────────────────────

interface OllamaSampling {
  temperature?: number | null; topP?: number | null; minP?: number | null; repeatPenalty?: number | null; seed?: number | null
}

interface ResolvedOllama { baseUrl: string; timeoutSecs: number; sampling: OllamaSampling }

/**
 * Endpoint + sampling for an Ollama model. A pre-resolved base URL (from an
 * ext: lookup) is used as-is; otherwise the matching (or first) enabled Ollama
 * ExternalModel supplies URL, timeout and sampling defaults.
 */
async function resolveOllama(model: string, baseUrl: string | undefined, timeoutSecs: number | undefined, sampling: OllamaSampling): Promise<ResolvedOllama | null> {
  if (baseUrl) return { baseUrl, timeoutSecs: timeoutSecs ?? 120, sampling }
  const ext = await prisma.externalModel.findFirst({ where: { provider: 'ollama', modelId: model, enabled: true } })
    ?? await prisma.externalModel.findFirst({ where: { provider: 'ollama', enabled: true } })
  if (!ext?.baseUrl) return null
  return {
    baseUrl: ext.baseUrl,
    timeoutSecs: ext.timeoutSecs ?? 120,
    sampling: {
      temperature:   sampling.temperature   ?? ext.temperature,
      topP:          sampling.topP          ?? ext.topP,
      minP:          sampling.minP          ?? ext.minP,
      repeatPenalty: sampling.repeatPenalty ?? ext.repeatPenalty,
      seed:          sampling.seed          ?? ext.seed,
    },
  }
}

// Tools the Ollama tool loop offers besides the gateway's. Kept in their
// original (Ollama-tuned) schemas; they execute through the tool registry.
const OLLAMA_LOCAL_TOOLS: ToolSpec[] = [
  {
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
  {
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
  {
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
]
const OLLAMA_LOCAL_NAMES: ReadonlySet<string> = new Set(OLLAMA_LOCAL_TOOLS.map(t => t.name))

/** The Ollama propose_tool schema ({command, parameters}) → the registry's ({inputSchema, execType, execConfig}). */
function adaptOllamaToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== 'propose_tool' || typeof args.command !== 'string' || args.inputSchema) return args
  const parameters = (args.parameters ?? {}) as Record<string, { type?: string; description?: string }>
  return {
    name:        String(args.name ?? '').trim().replace(/\s+/g, '_'),
    description: String(args.description ?? ''),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, { type: v.type ?? 'string', description: v.description }])),
      required: Object.keys(parameters),
    },
    execType:   'shell',
    execConfig: { command: args.command },
  }
}

/** Plain streaming Ollama chat (no tools). */
async function* streamOllamaPlain(
  run: ChatRun, systemPrompt: string, history: ChatHistory, model: string,
  baseUrl: string | undefined, timeoutSecs: number | undefined, sampling: OllamaSampling, abortSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const cfg = await resolveOllama(model, baseUrl, timeoutSecs, sampling)
  if (!cfg) {
    yield { type: 'error', error: 'Ollama error: No Ollama model configured — add one in Admin → Models' }
    return
  }
  await run.trace({ type: 'text_generation', content: run.prompt, fullContext: buildFullContextSnapshot(systemPrompt, history) })
  yield* streamPlainChat({
    run,
    provider: createOllamaProvider({ baseUrl: cfg.baseUrl, model, stream: true, timeoutMs: cfg.timeoutSecs * 1000, options: buildOllamaOptions(cfg.sampling) }),
    messages: chatMessages(systemPrompt, history, run.prompt),
    signal: abortSignal,
    errorPrefix: 'Ollama error: ',
  })
}

/** Ollama tool loop (non-streaming turns) with the gateway's tools. */
async function* streamOllamaTools(
  run: ChatRun, systemPrompt: string, history: ChatHistory, model: string,
  baseUrl: string | undefined, gw: ChatGateway, abortSignal: AbortSignal | undefined, userId: string | undefined, sampling: OllamaSampling,
): AsyncGenerator<StreamChunk> {
  await run.trace({ type: 'text_generation', content: run.prompt, fullContext: buildFullContextSnapshot(systemPrompt, history, gw.tools) })
  const cfg = await resolveOllama(model, baseUrl, undefined, sampling)
  if (!cfg) { yield { type: 'error', error: 'No Ollama model configured' }; return }

  const role = await getChatUserRole(userId)
  const tools = filterToolsForRole([...gw.tools.map(toSpec), ...OLLAMA_LOCAL_TOOLS], role, t => t.name)
  const cap = new RunTokenCap(await getRunTokenCap())

  yield* streamChatLoop({
    run,
    provider: createOllamaProvider({ baseUrl: cfg.baseUrl, model, stream: false, timeoutMs: cfg.timeoutSecs * 1000, options: buildOllamaOptions(cfg.sampling) }),
    messages: chatMessages(systemPrompt, history, run.prompt),
    tools,
    maxTurns: 15,
    signal: abortSignal,
    toolCtx: {
      userId, environmentId: gw.environmentId, conversationId: run.conversationId, gateway: gw.client,
      validate: false, registryNames: OLLAMA_LOCAL_NAMES, adaptArgs: adaptOllamaToolArgs,
    },
    runCap: {
      cap,
      after: (r, msgs) => (r.usage?.inputTokens ?? estimateTokens(JSON.stringify(msgs))) + (r.usage?.outputTokens ?? estimateTokens(r.text ?? '')),
    },
    logToolCalls: false,
    toolsUsedOverride: gw.tools.map(t => t.name),
    savedText: 'final',
    errorPrefix: 'Ollama error: ',
  })
}

export async function* streamOllamaChat(
  prompt: string,
  conversationId: string,
  history: ChatHistory,
  model: string,
  baseUrl?: string,
  abortSignal?: AbortSignal,
  userId?: string,
  targetEnvironmentId?: string,
  systemPromptOverride?: string,
  knowledgeContext?: string,
  _traceId?: string,
): AsyncGenerator<StreamChunk> {
  const run = new ChatRun(conversationId, prompt, model)
  const gw = await connectChatGateway(userId, targetEnvironmentId)

  // No gateway tools — plain streaming chat with an honest system prompt
  if (!gw?.tools.length) {
    const sp = systemPromptOverride ?? await getSystemPrompt([], undefined, undefined, knowledgeContext)
    yield* streamOllamaPlain(run, sp, history, model, baseUrl, undefined, {}, abortSignal)
    return
  }

  const systemPrompt = await getSystemPrompt(gw.tools.map(t => t.name), undefined, undefined, knowledgeContext)
  yield* streamOllamaTools(run, systemPrompt, history, model, baseUrl, gw, abortSignal, userId, {})
}

// ── OpenAI-compatible chat (custom / openai providers) ────────────────────────

interface OpenAISampling { temperature?: number | null; topP?: number | null; seed?: number | null }

async function* streamOpenAIChatCore(
  run: ChatRun,
  systemPrompt: string,
  history: ChatHistory,
  model: string,
  baseUrl: string,
  apiKey: string | undefined,
  gw: { client: GatewayClient | null; tools: GatewayTool[]; environmentId?: string },
  abortSignal: AbortSignal | undefined,
  userId: string | undefined,
  sampling: OpenAISampling = {},
): AsyncGenerator<StreamChunk> {
  await run.trace({ type: 'text_generation', content: run.prompt, fullContext: buildFullContextSnapshot(systemPrompt, history, gw.tools) })

  // Registry tools + gateway tools, filtered by the caller's role so the model
  // is never offered tools this user can't run (readonly → no tools at all).
  const role = await getChatUserRole(userId)
  const tools = filterToolsForRole(dedupeTools([...registryChatToolSpecs(), ...gw.tools.map(toSpec)]), role, t => t.name)

  const extraBody: Record<string, unknown> = {}
  if (sampling.temperature != null) extraBody.temperature = sampling.temperature
  if (sampling.topP        != null) extraBody.top_p       = sampling.topP
  if (sampling.seed        != null) extraBody.seed        = sampling.seed

  // Per-run token cap — the stream doesn't report usage, so each turn's spend
  // is estimated from the request messages plus the streamed reply.
  const cap = new RunTokenCap(await getRunTokenCap())

  yield* streamChatLoop({
    run,
    provider: createOpenAIProvider({
      url: `${baseUrl}/chat/completions`,
      apiKey,
      model,
      stream: true,
      timeoutMs: 120_000,
      extraBody,
      httpErrorMessage: (status, body) => `OpenAI-compatible API ${status}: ${body}`,
    }),
    messages: chatMessages(systemPrompt, history, run.prompt),
    tools,
    maxTurns: 10,
    signal: abortSignal,
    toolCtx: {
      userId, environmentId: gw.environmentId, conversationId: run.conversationId, gateway: gw.client,
      validate: true, gatewaySchemas: new Map(gw.tools.map(t => [t.name, t.inputSchema])),
    },
    runCap: {
      cap,
      before: msgs => estimateTokens(JSON.stringify(msgs)),
      after: r => estimateTokens((r.text ?? '') + r.toolCalls.map(tc => tc.argsRaw).join('')),
    },
    logToolCalls: true,
    savedText: 'all',
    errorPrefix: 'OpenAI API error: ',
  })
}

export async function* streamOpenAIChat(
  prompt: string,
  conversationId: string,
  history: ChatHistory,
  model: string,
  baseUrl: string,
  apiKey?: string,
  abortSignal?: AbortSignal,
  userId?: string,
  targetEnvironmentId?: string,
  systemPromptOverride?: string,
  knowledgeContext?: string,
  _traceId?: string,
): AsyncGenerator<StreamChunk> {
  const run = new ChatRun(conversationId, prompt, model)
  const gw = await connectChatGateway(userId, targetEnvironmentId)
  const gatewayTools = gw?.tools ?? []
  const systemPrompt = systemPromptOverride ?? await getSystemPrompt(gatewayTools.map(t => t.name), undefined, conversationId, knowledgeContext)
  yield* streamOpenAIChatCore(
    run, systemPrompt, history, model, baseUrl, apiKey,
    { client: gatewayTools.length ? gw!.client : null, tools: gatewayTools, environmentId: gw?.environmentId },
    abortSignal, userId,
  )
}

// ── Gemini chat ──────────────────────────────────────────────────────────────

export async function* streamGeminiChat(
  prompt: string,
  conversationId: string,
  history: ChatHistory,
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
  history: ChatHistory,
  model: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    yield { type: 'error', error: 'Gemini API key not configured — add GEMINI_API_KEY to Vault secret/orion' }
    return
  }
  const run = new ChatRun(conversationId, prompt, model)
  await run.trace({ type: 'text_generation', content: prompt, fullContext: buildFullContextSnapshot(systemPrompt, history) })
  yield* streamPlainChat({
    run,
    provider: createGeminiProvider({ apiKey, model, timeoutMs: 120_000 }),
    messages: chatMessages(systemPrompt, history, prompt),
    signal: abortSignal,
    errorPrefix: 'Gemini error: ',
  })
}

// ── Agent chat ───────────────────────────────────────────────────────────────

/**
 * Direct chat with an agent. Enforces the agent's token budget (previously only
 * worker task runs did): checks before the call, records estimated spend after.
 * Providers on this path don't report usage, so spend is estimated from length.
 */
export async function* streamAgentChat(
  prompt: string,
  conversationId: string,
  agentSystemPrompt: string,
  previousMessages: ChatHistory = [],
  contextConfig: AgentContextConfig = {},
  agentId?: string,
  userId?: string,
  targetEnvironmentId?: string,
  knowledgeContext?: string,
  traceId?: string,
): AsyncGenerator<StreamChunk> {
  const run = await beginBudgetedRun(agentId)
  if (!run.allowed) {
    yield { type: 'error', error: `This agent is over its token budget: ${run.reason}` }
    return
  }
  const inputEstimate = estimateTokens(
    agentSystemPrompt + (knowledgeContext ?? '') + previousMessages.map(m => m.content).join('\n') + prompt,
  )
  let outputText = ''
  try {
    for await (const chunk of streamAgentChatInner(
      prompt, conversationId, agentSystemPrompt, previousMessages, contextConfig,
      agentId, userId, targetEnvironmentId, knowledgeContext, traceId,
    )) {
      if (chunk.type === 'text' && chunk.content) outputText += chunk.content
      if (chunk.type === 'tool_result' && chunk.output) outputText += chunk.output
      yield chunk
    }
  } finally {
    // Runs on normal completion and when the consumer stops after `done`
    await run.finish(inputEstimate, estimateTokens(outputText), contextConfig.llm ?? 'claude')
  }
}

async function* streamAgentChatInner(
  prompt: string,
  conversationId: string,
  agentSystemPrompt: string,
  previousMessages: ChatHistory = [],
  contextConfig: AgentContextConfig = {},
  agentId?: string,
  userId?: string,
  targetEnvironmentId?: string,
  knowledgeContext?: string,
  _traceId?: string,
): AsyncGenerator<StreamChunk> {
  const historyLimit   = contextConfig.historyMessages ?? 6
  const summarizeAfter = contextConfig.summarizeAfter  ?? 20
  const llm            = contextConfig.llm             ?? 'claude'

  const trimmedHistory = await maybeGetSummarizedHistory(conversationId, previousMessages, summarizeAfter, historyLimit)

  // SOC2 [A-002]: an agent only gets gateway tools from an environment it is
  // explicitly linked to (or one the user @mentioned) — never an implicit
  // fallback to any connected environment, which exposed that gateway to
  // agents with no assignment. readonly users never get tools.
  const toolsAllowed = canUseTools(await getChatUserRole(userId))

  const loadAgentGateway = async (): Promise<ChatGateway | null> => {
    if (!toolsAllowed) return null
    const gwWhere = { status: 'connected', gatewayUrl: { not: null }, gatewayToken: { not: null } } as const
    let env = targetEnvironmentId
      ? await prisma.environment.findFirst({ where: { id: targetEnvironmentId, ...gwWhere } })
      : null
    if (!env && agentId) {
      env = await prisma.environment.findFirst({ where: { ...gwWhere, agents: { some: { agentId } } } })
    }
    if (!env?.gatewayUrl || !env.gatewayToken) return null
    try {
      const client = new GatewayClient(env.gatewayUrl, env.gatewayToken, humanActor(userId))
      const tools = await client.listTools()
      return tools.length ? { tools, client, environmentId: env.id } : null
    } catch {
      return null
    }
  }

  const kcSection = knowledgeContext ? '\n\n---\n## Relevant Knowledge Base\n\n' + knowledgeContext + '\n---' : ''

  if (llm.startsWith('ollama:') || llm.startsWith('ext:')) {
    let model: string
    let baseUrl: string | undefined
    let timeoutSecs = 120
    let provider = 'ollama'
    let apiKey: string | undefined
    let sampling: OllamaSampling = {}

    if (llm.startsWith('ext:')) {
      const extId = llm.slice('ext:'.length)
      const extModel = await prisma.externalModel.findUnique({ where: { id: extId } })
      if (!extModel) { yield { type: 'error', error: `External model not found: ${extId}` }; return }
      model = extModel.modelId || 'default'
      baseUrl = extModel.baseUrl ?? undefined
      timeoutSecs = extModel.timeoutSecs ?? 120
      provider = extModel.provider   // 'ollama' | 'openai' | 'custom' | etc.
      apiKey = extModel.apiKey ?? undefined
      sampling = {
        temperature: extModel.temperature, topP: extModel.topP, minP: extModel.minP,
        repeatPenalty: extModel.repeatPenalty, seed: extModel.seed,
      }
    } else {
      model = llm.slice('ollama:'.length)
    }

    const gw = await loadAgentGateway()
    const noGwSuffix = '\n\nNo MCP gateway is connected right now. You cannot run tools or commands. Be honest about this limitation.'
    const activeTasks = await getActiveTasksSection()
    const run = new ChatRun(conversationId, prompt, model)

    if (provider === 'ollama') {
      if (gw) {
        const systemPrompt = await getSystemPrompt(gw.tools.map(t => t.name), agentSystemPrompt + activeTasks, conversationId, knowledgeContext)
        yield* streamOllamaTools(run, systemPrompt, trimmedHistory, model, baseUrl, gw, undefined, userId, sampling)
      } else {
        yield* streamOllamaPlain(run, agentSystemPrompt + activeTasks + noGwSuffix + kcSection, trimmedHistory, model, baseUrl, timeoutSecs, sampling)
      }
      return
    }

    // OpenAI-compatible endpoint (custom / openai / llama.cpp / etc.). The
    // ORION template would conflict with the agent's persona, so the prompt is
    // built here: stable parts first (persona, tools, rules, cluster context),
    // volatile parts last (active tasks, RAG) so the prefix is cacheable.
    const openAISystemPrompt = gw
      ? `${agentSystemPrompt}

You have the following MCP tools available:
${gw.tools.map(t => `  - ${t.name}: ${t.description || 'No description'}`).join('\n')}

Tool usage rules:
- Call tools immediately when you need real data. Do not ask permission first.
- NEVER make up or hallucinate tool output. Always use a tool and return its real result.

${readClusterContext()}${activeTasks}${kcSection}`
      : agentSystemPrompt + activeTasks + noGwSuffix + kcSection
    yield* streamOpenAIChatCore(
      run, openAISystemPrompt, trimmedHistory, model, baseUrl!, apiKey,
      { client: gw?.client ?? null, tools: gw?.tools ?? [], environmentId: gw?.environmentId },
      undefined, userId,
      { temperature: sampling.temperature, topP: sampling.topP, seed: sampling.seed },
    )
    return
  }

  if (llm.startsWith('gemini:')) {
    yield* streamGeminiAgentChat(prompt, conversationId, agentSystemPrompt, trimmedHistory, llm.slice('gemini:'.length))
    return
  }

  // Claude path — claude:<model-id> or bare 'claude' (default)
  const claudeModel  = llm.startsWith('claude:') ? llm.slice('claude:'.length) : undefined
  const maxTurns     = contextConfig.maxTurns ?? 6
  const allowedTools = toolsAllowed ? (contextConfig.allowedTools ?? []) : []

  const overridePrompt = `You are NOT Claude Code and NOT the Claude CLI. Do not mention or reference Claude Code, Anthropic's CLI, or any developer tooling.

${agentSystemPrompt}

Respond only in the persona described above. Never break character or refer to yourself as Claude Code.${kcSection}`

  yield* streamClaudeResponse(prompt, conversationId, trimmedHistory, null, overridePrompt, {
    maxTurns,
    allowedTools,
    ...(claudeModel && { model: claudeModel }),
  }, undefined, undefined, targetEnvironmentId)
}

// ── History summarization ─────────────────────────────────────────────────────

// Summarize old messages and store the summary on the conversation.
// Returns [summary context message] + last N recent messages.
async function maybeGetSummarizedHistory(
  conversationId: string,
  messages: ChatHistory,
  summarizeAfter: number,
  recentCount: number,
): Promise<ChatHistory> {
  if (messages.length <= recentCount) return messages

  const convo = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { metadata: true } })
  const meta = (convo?.metadata ?? {}) as Record<string, unknown>

  // Summarize if we're over the threshold and don't have a fresh summary
  const summarizedUpTo = meta.summarizedUpTo as number | undefined
  const needsSummary = messages.length >= summarizeAfter &&
    (summarizedUpTo === undefined || messages.length - summarizedUpTo > summarizeAfter / 2)

  const withSummary = (summary: string): ChatHistory => [
    { role: 'user', content: `[Previous conversation summary]\n${summary}` },
    { role: 'assistant', content: 'Understood, I have reviewed the conversation history.' },
    ...messages.slice(-recentCount),
  ]

  if (needsSummary) {
    const summaryText = await generateSummary(messages.slice(0, -recentCount))
    if (summaryText) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          metadata: { ...meta, contextSummary: summaryText, summarizedUpTo: messages.length - recentCount } as Prisma.InputJsonValue,
        },
      })
      return withSummary(summaryText)
    }
  }

  if (typeof meta.contextSummary === 'string' && meta.contextSummary) return withSummary(meta.contextSummary)
  return messages.slice(-recentCount)
}

const SUMMARY_SYSTEM = 'You are a conversation summarizer. Produce a detailed factual summary that preserves important context and facts.'

async function generateSummary(messages: ChatHistory): Promise<string | null> {
  if (messages.length === 0) return null
  const transcript = messages.map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 1000)}`).join('\n\n')
  const prompt = `Create a detailed conversation summary that captures:
- Key facts discovered or established (names, values, configurations)
- Decisions made and the reasoning behind them
- Important context about systems, services, or state
- Any pending items or unresolved questions

Be specific with details. Use 5-8 sentences if needed for completeness:

${transcript}`

  // Try Ollama first — free, local, no Claude quota
  const ollamaExt = await prisma.externalModel.findFirst({ where: { provider: 'ollama', enabled: true } })
  if (ollamaExt) {
    try {
      const r = await completeOnce({ kind: 'ollama', baseUrl: ollamaExt.baseUrl, model: ollamaExt.modelId }, prompt, {
        system: SUMMARY_SYSTEM, options: { temperature: 0.1, num_predict: 500 }, timeoutMs: 30_000,
      })
      if (r.text) return r.text
    } catch { /* Ollama unavailable — fall through to Claude */ }
  }

  // Fallback: the orion-claude sidecar (the OAuth token stays in the sidecar)
  try {
    const r = await completeOnce({ kind: 'claude' }, prompt, { system: SUMMARY_SYSTEM, timeoutMs: 60_000 })
    return r.text.trim() || null
  } catch { /* orion-claude unreachable */ }
  return null
}

// ── Claude (orion-claude sidecar) chat ────────────────────────────────────────

export async function* streamClaudeResponse(
  prompt: string,
  conversationId: string,
  previousMessages: ChatHistory = [],
  planTarget?: { type: string; id: string } | null,
  agentSystemPrompt?: string,
  overrides?: { maxTurns?: number; allowedTools?: string[]; model?: string },
  abortSignal?: AbortSignal,
  knowledgeContext?: string,
  environmentId?: string,
): AsyncGenerator<StreamChunk> {
  const toolsUsed: string[] = []
  const toolCallLog: ToolCallLogEntry[] = []
  let totalText = ''
  // Model: explicit override > SystemSetting model.role.<chat|planner> > built-in default.
  // Only forwarded to the sidecar when it differs from the built-in default, so
  // the sidecar's own default applies until an admin configures an override.
  const modelRole: ModelRole = planTarget ? 'planner' : 'chat'
  const claudeModel = overrides?.model ?? await resolveModel(modelRole)
  const sidecarModel = overrides?.model ?? (claudeModel !== DEFAULT_ROLE_MODELS[modelRole] ? claudeModel : undefined)
  const run = new ChatRun(conversationId, prompt, claudeModel)

  try {
    // Stable system prompt vs. volatile per-turn context (RAG, memories, skills):
    // the sidecar keeps the stable part byte-identical across turns so Claude
    // Code's prompt cache hits, and sends the volatile part in the user turn.
    let parts: SystemPromptParts
    if (agentSystemPrompt) {
      parts = {
        stable: agentSystemPrompt,
        volatile: knowledgeContext ? '\n\n---\n## Relevant Knowledge Base\n\n' + knowledgeContext + '\n---' : '',
      }
    } else if (planTarget) {
      parts = { stable: await getPlanningSystemPrompt(planTarget.type), volatile: '' }
    } else {
      parts = await getSystemPromptParts([], undefined, conversationId, knowledgeContext)
    }

    // Matched skill(s) go in the volatile tail too.
    let context = parts.volatile
    if (environmentId) {
      const { injected, skillName } = await matchAndInjectSkills(environmentId, prompt, 'chat_match', conversationId)
      if (injected) context += `\n\n---\n## INJECTED SKILL: ${skillName}\n${injected}\n---`
    }

    const allowedTools = overrides?.allowedTools ?? ALLOWED_TOOLS
    await run.trace({
      type: 'text_generation',
      content: prompt,
      fullContext: buildFullContextSnapshot(parts.stable + context, previousMessages, allowedTools.map(name => ({ name }))),
    })

    // Trace writes are fire-and-forget during streaming (step numbers are
    // assigned synchronously so ordering is preserved) and awaited at the end.
    try {
      for await (const ev of sidecarStream({
        system: parts.stable,
        context,
        messages: [...previousMessages.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: prompt }],
        transcript: 'chat',
        allowedTools,
        maxTurns: overrides?.maxTurns ?? 20,
        ...(sidecarModel && { model: sidecarModel }),
      }, { timeoutMs: 300_000, signal: abortSignal })) {
        if (ev.type === 'text') {
          totalText += ev.text
          run.traceLater({ type: 'text_generation', content: ev.text })
          yield { type: 'text', content: ev.text }
        } else if (ev.type === 'tool_use') {
          const input = JSON.stringify(ev.input ?? {})
          toolsUsed.push(`${ev.name}(${input})`)
          toolCallLog.push({ tool: ev.name, input })
          run.traceLater({ type: 'tool_call', toolName: ev.name, toolArgs: input })
          yield { type: 'tool_call', tool: ev.name, input }
        } else if (ev.type === 'tool_result') {
          const last = toolCallLog.at(-1)
          run.traceLater({ type: 'tool_result', toolName: last?.tool ?? null, toolResult: ev.content })
          if (last) last.output = ev.content
          yield { type: 'tool_result', output: ev.content }
        } else {
          const resultText = ev.subtype === 'success' ? ev.result : undefined
          process.stderr.write(`[claude] result: subtype=${ev.subtype} result_len=${resultText?.length ?? 0}\n`)
          if (resultText?.trim() && !totalText.includes(resultText.trim())) {
            totalText += (totalText ? '\n\n' : '') + resultText
            run.traceLater({ type: 'text_generation', content: resultText })
            yield { type: 'text', content: resultText }
          }
        }
      }
    } finally {
      await run.flushTraces()
    }

    // Planning only: the reviewer model refines the draft via orion-claude.
    let review = ''
    if (planTarget && totalText.trim()) {
      yield { type: 'text', content: '\n\n---\n\n*Reviewing with Opus...*\n\n' }
      const r = await sidecarCollect({
        system: await getPrompt('system.plan-review'),
        messages: [{
          role: 'user',
          content: `Review this draft plan and output the final, improved version. Work only from the text below — do not attempt to run any commands or gather additional information. Fill gaps, sharpen implementation steps, remove vagueness, and ensure the plan is complete and actionable. Output the final plan directly with no preamble and no open-ended questions at the end.

Draft plan to review:

${totalText}`,
        }],
        allowedTools: [],
        maxTurns: 1,
        model: await resolveModel('reviewer'),
      }, { timeoutMs: 120_000 }).catch(() => null)
      if (r?.ok && r.text) {
        review = r.text
        yield { type: 'text', content: r.text }
      }
    }

    const fullContent = review ? `${totalText}\n\n---\n\n*Reviewing with Opus...*\n\n${review}` : totalText
    // Save BEFORE yielding done — the consumer stops at the first `done`.
    await run.persist(fullContent, toolsUsed, toolCallLog)
    await run.trace({ type: 'text_generation', content: totalText, durationMs: Date.now() - run.start })
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await run.recordFailure(toolsUsed, msg, true)
    yield { type: 'error', error: msg }
  }
}
