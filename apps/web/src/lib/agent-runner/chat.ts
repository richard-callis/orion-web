/**
 * Human chat on the shared engine: StreamChunk mapping for the SSE route,
 * agent tracing, message persistence, and the chat tool policy.
 *
 * Every tool call from human chat goes through one gate (checkChatToolPermission:
 * readonly/anonymous → nothing, admin-only tools, destructive tools need an env
 * admin tier or a one-time grant — checked exactly once per call so a grant is
 * never consumed twice), then dispatches to the tool registry or the gateway.
 */
import { prisma } from '../db'
import { executeRegisteredTool, validateToolArgs } from '../tool-registry'
import { MANAGEMENT_TOOL_DEFS } from '../management-tools'
import { checkChatToolPermission } from '../chat-tool-policy'
import type { GatewayClient } from './gateway-client'
import { runToolLoop, type LoopEvent, type RunCapAccounting } from './engine/loop'
import type { ChatProvider, EngineMessage, ToolCallRequest, ToolSpec } from './engine/types'

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error'
  content?: string
  tool?: string
  input?: string
  output?: string
  error?: string
}

export type ChatHistory = Array<{ role: string; content: string }>

// ── Tracing ───────────────────────────────────────────────────────────────────

export interface TraceData {
  conversationId?: string | null
  taskId?: string | null
  step: number
  type: string
  toolName?: string | null
  toolArgs?: string | null
  toolResult?: string | null
  content?: string | null
  skillName?: string | null
  hookName?: string | null
  durationMs?: number | null
  modelUsed?: string | null
  fullContext?: string | null
}

export async function recordTrace(data: TraceData): Promise<void> {
  await prisma.agentTrace.create({ data }).catch(() => { /* non-fatal — tracing must not break chat */ })
}

/**
 * Serialize the full context sent to the LLM (system prompt + tool list +
 * conversation history) into one readable text block, for the agent-context
 * viewer. Only recorded on the first trace step of a run.
 */
export function buildFullContextSnapshot(
  systemPrompt: string,
  history: ChatHistory,
  tools?: Array<{ name: string; description?: string }>,
): string {
  const parts: string[] = [`=== SYSTEM PROMPT ===\n${systemPrompt}`]
  if (tools && tools.length) {
    parts.push(`=== TOOLS AVAILABLE (${tools.length}) ===\n` + tools.map(t => `- ${t.name}: ${t.description ?? '(no description)'}`).join('\n'))
  }
  if (history.length) {
    parts.push(`=== CONVERSATION HISTORY (${history.length} messages) ===\n` + history.map(m => `[${m.role}] ${m.content}`).join('\n\n'))
  }
  return parts.join('\n\n')
}

// ── Run bookkeeping (traces, persistence) ────────────────────────────────────

const MAX_STORE_CHARS = 4000

// A type alias (not an interface) so it is assignable to Prisma JSON input.
export type ToolCallLogEntry = { tool: string; input: string; output?: string }

/** Per-run trace step counter plus persistence of the exchange. */
export class ChatRun {
  private step = 0
  private pending: Promise<void>[] = []
  readonly start = Date.now()

  constructor(readonly conversationId: string, readonly prompt: string, readonly model: string) {}

  async trace(data: Omit<TraceData, 'step' | 'conversationId' | 'modelUsed'>): Promise<void> {
    await recordTrace({ conversationId: this.conversationId, modelUsed: this.model, step: ++this.step, ...data })
  }

  /** Fire-and-forget trace (per streamed chunk); the step number is assigned now so ordering holds. */
  traceLater(data: Omit<TraceData, 'step' | 'conversationId' | 'modelUsed'>): void {
    this.pending.push(recordTrace({ conversationId: this.conversationId, modelUsed: this.model, step: ++this.step, ...data }))
  }

  async flushTraces(): Promise<void> {
    await Promise.all(this.pending)
    this.pending = []
  }

  /** Save the user prompt, the (capped) reply and the invocation record. */
  async persist(content: string, toolsUsed: string[], toolCallLog?: ToolCallLogEntry[]): Promise<void> {
    const saved = content.length > MAX_STORE_CHARS ? content.slice(0, MAX_STORE_CHARS) + '\n[…truncated for storage]' : content
    await Promise.all([
      prisma.message.create({ data: { conversationId: this.conversationId, role: 'user', content: this.prompt } }),
      prisma.message.create({
        data: {
          conversationId: this.conversationId,
          role: 'assistant',
          content: saved,
          ...(toolCallLog !== undefined && { metadata: toolCallLog.length ? { toolCalls: toolCallLog } : undefined }),
        },
      }),
      prisma.claudeInvocation.create({
        data: { conversationId: this.conversationId, prompt: this.prompt, toolsUsed, durationMs: Date.now() - this.start, success: true },
      }),
    ])
  }

  async recordFailure(toolsUsed: string[], message: string, traceError: boolean): Promise<void> {
    await prisma.claudeInvocation.create({
      data: { conversationId: this.conversationId, prompt: this.prompt, toolsUsed, durationMs: Date.now() - this.start, success: false },
    }).catch(() => {})
    if (traceError) await this.trace({ type: 'error', content: message, durationMs: Date.now() - this.start })
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────

/** System prompt + history (user stays user, everything else becomes assistant) + the new prompt. */
export function chatMessages(systemPrompt: string, history: ChatHistory, prompt: string): EngineMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.content })),
    { role: 'user', content: prompt },
  ]
}

// ── Tool policy + dispatch ────────────────────────────────────────────────────

/** Registry tools reachable from human chat (room-only tools are excluded). */
const CHAT_REGISTRY_TOOLS = new Set(MANAGEMENT_TOOL_DEFS.map(d => d.name))

export function registryChatToolSpecs(): ToolSpec[] {
  return MANAGEMENT_TOOL_DEFS.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema }))
}

export function dedupeTools(tools: ToolSpec[]): ToolSpec[] {
  const seen = new Set<string>()
  return tools.filter(t => (seen.has(t.name) ? false : (seen.add(t.name), true)))
}

export interface ChatToolContext {
  userId?: string
  environmentId?: string
  conversationId: string
  gateway: GatewayClient | null
  /** Validate arguments against the registry schema first (OpenAI-compatible path). */
  validate: boolean
  /** Extra names dispatched to the registry even if not in the chat set. */
  registryNames?: ReadonlySet<string>
  /** Rewrite model arguments for a tool before dispatch (legacy local tool schemas). */
  adaptArgs?: (name: string, args: Record<string, unknown>) => Record<string, unknown>
}

function parseArgs(argsRaw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(argsRaw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export async function runChatTool(call: ToolCallRequest, ctx: ChatToolContext): Promise<string> {
  let args = parseArgs(call.argsRaw)

  if (ctx.validate) {
    const validation = validateToolArgs(call.name, args)
    if (!validation.valid) {
      return `Tool validation failed for ${call.name}: ${validation.errors.join(', ')}. Check the tool schema and retry with correct arguments.`
    }
  }

  // Single permission gate for every tool (registry and gateway).
  const perm = await checkChatToolPermission(call.name, args, ctx.environmentId ?? '', ctx.conversationId, ctx.userId)
  if (!perm.allowed) return `Permission denied: ${perm.reason}`

  if (CHAT_REGISTRY_TOOLS.has(call.name) || ctx.registryNames?.has(call.name)) {
    if (ctx.adaptArgs) args = ctx.adaptArgs(call.name, args)
    // An ordinary per-user chat (no autonomous Agent acting): the human is
    // ctx.userId — never ctx.agentId, which is an Agent.id foreign key.
    return executeRegisteredTool(call.name, args, {
      userId: ctx.userId,
      environmentId: ctx.environmentId,
      conversationId: ctx.conversationId,
      prisma,
    })
  }
  if (ctx.gateway && ctx.environmentId) {
    try {
      return await ctx.gateway.executeTool(call.name, args)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return 'No gateway connected'
}

// ── Tool loop → StreamChunks ─────────────────────────────────────────────────

export interface ChatLoopOptions {
  run: ChatRun
  provider: ChatProvider
  messages: EngineMessage[]
  tools: ToolSpec[]
  maxTurns: number
  toolCtx: ChatToolContext
  runCap: RunCapAccounting
  signal?: AbortSignal
  /** Record the tool call log in the saved assistant message's metadata. */
  logToolCalls: boolean
  /** Names recorded as "tools used" on the invocation (default: the calls made). */
  toolsUsedOverride?: string[]
  /**
   * What the saved reply contains: 'all' — every streamed text chunk (plus the
   * cap notice appended); 'final' — only the final reply (the cap notice
   * replaces it).
   */
  savedText: 'all' | 'final'
  errorPrefix: string
}

/**
 * Run the engine loop for a chat turn and map it to the StreamChunks the SSE
 * route and UI consume. `done` is yielded only after the exchange is saved:
 * the consumer stops at the first `done`, which would skip anything after it.
 */
export async function* streamChatLoop(opts: ChatLoopOptions): AsyncGenerator<StreamChunk> {
  const { run } = opts
  const toolsUsed: string[] = []
  const toolCallLog: ToolCallLogEntry[] = []
  const logByCall = new Map<ToolCallRequest, ToolCallLogEntry>()
  let totalText = ''

  try {
    let ev: LoopEvent
    for await (ev of runToolLoop({
      provider: opts.provider,
      messages: opts.messages,
      tools: opts.tools,
      maxTurns: opts.maxTurns,
      signal: opts.signal,
      runCap: opts.runCap,
      hooks: {
        runTool: call => runChatTool(call, opts.toolCtx),
        beforeToolCall: async call => {
          await run.trace({ type: 'tool_call', toolName: call.name, toolArgs: call.argsRaw })
          toolsUsed.push(call.name)
          const entry = { tool: call.name, input: call.argsRaw }
          logByCall.set(call, entry)
          toolCallLog.push(entry)
        },
        afterToolResult: async (call, result, durationMs) => {
          const entry = logByCall.get(call)
          if (entry) entry.output = result
          await run.trace({ type: 'tool_result', toolName: call.name, toolResult: result, durationMs })
        },
      },
    })) {
      if (ev.type === 'text') {
        if (opts.savedText === 'all') totalText += ev.content
        yield { type: 'text', content: ev.content }
      } else if (ev.type === 'tool_call') {
        yield { type: 'tool_call', tool: ev.tool, input: ev.args }
      } else if (ev.type === 'tool_result') {
        yield { type: 'tool_result', tool: ev.tool, output: ev.result }
      } else if (ev.reason === 'cap') {
        const notice = opts.runCap.cap.message
        totalText = opts.savedText === 'all' ? totalText + (totalText ? '\n\n' : '') + notice : notice
        yield { type: 'text', content: notice }
      } else if (opts.savedText === 'final' && ev.finalText) {
        totalText = ev.finalText
        await run.trace({ type: 'text_generation', content: ev.finalText })
      }
    }

    if (opts.savedText === 'final') {
      await run.trace({ type: 'text_generation', content: totalText, durationMs: Date.now() - run.start })
      await run.persist(totalText, opts.toolsUsedOverride ?? toolsUsed, opts.logToolCalls ? toolCallLog : undefined)
    } else {
      await run.persist(totalText, opts.toolsUsedOverride ?? toolsUsed, opts.logToolCalls ? toolCallLog : undefined)
      await run.trace({ type: 'text_generation', content: totalText, durationMs: Date.now() - run.start })
    }
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Only the OpenAI-compatible path recorded an error trace (savedText 'all').
    await run.recordFailure([], msg, opts.savedText === 'all')
    yield { type: 'error', error: `${opts.errorPrefix}${msg}` }
  }
}

/**
 * Plain streaming chat (no tools): Ollama NDJSON, Gemini. Text chunks are
 * traced without blocking the stream.
 */
export async function* streamPlainChat(opts: {
  run: ChatRun
  provider: ChatProvider
  messages: EngineMessage[]
  signal?: AbortSignal
  errorPrefix: string
}): AsyncGenerator<StreamChunk> {
  const { run } = opts
  let totalText = ''
  try {
    for await (const ev of runToolLoop({
      provider: opts.provider,
      messages: opts.messages,
      tools: [],
      maxTurns: 1,
      signal: opts.signal,
      hooks: { runTool: async () => '' },
    })) {
      if (ev.type !== 'text') continue
      totalText += ev.content
      run.traceLater({ type: 'text_generation', content: ev.content })
      yield { type: 'text', content: ev.content }
    }
    await run.flushTraces()
    await run.persist(totalText, [])
    await run.trace({ type: 'text_generation', content: totalText, durationMs: Date.now() - run.start })
    yield { type: 'done' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await run.flushTraces()
    await run.recordFailure([], msg, true)
    yield { type: 'error', error: `${opts.errorPrefix}${msg}` }
  }
}
