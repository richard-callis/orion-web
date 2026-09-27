/**
 * The one shared LLM tool loop.
 *
 * Drives any ChatProvider: call the model, and while it asks for tools, run
 * them through the caller's hooks and feed the results back. Callers supply
 * policy through hooks (permission checks, validation, checkpoint replay,
 * dispatch, tracing, persistence) and map the neutral LoopEvents to their own
 * event formats — AgentEvent for the worker, StreamChunk for chat SSE, a
 * reply string for rooms.
 *
 * Ordering guarantees the worker's plan-approval gate relies on:
 *   1. text the model writes alongside tool calls is yielded BEFORE the
 *      tool_call events (when emitTextWithToolCalls is set);
 *   2. every tool_call is yielded BEFORE that tool runs — including a
 *      parallel-safe batch, which is announced in full before any of it runs.
 * A consumer that stops iterating at a tool_call therefore prevents it (and
 * the rest of its batch) from executing.
 */
import { throwIfAborted } from '../abort'
import type { RunTokenCap } from '../../llm-budget'
import type { ChatProvider, EngineMessage, TokenUsage, ToolCallRequest, ToolSpec, TurnResult } from './types'

export interface ToolLoopHooks {
  /** Run one tool call; `step` is its 1-based position among all calls in this run. */
  runTool(call: ToolCallRequest, step: number): Promise<string>
  /** Awaited before a call's tool_call event is yielded (e.g. tracing). */
  beforeToolCall?(call: ToolCallRequest): Promise<void> | void
  /** Awaited after a call ran, before its tool_result event is yielded. */
  afterToolResult?(call: ToolCallRequest, result: string, durationMs: number): Promise<void> | void
  /**
   * Inspect a final reply (no tool calls). Return the assistant/user message
   * pair to append (reject the reply and run another turn), or null to accept.
   */
  reviewFinal?(text: string | null): { assistant: string; user: string } | null
}

export interface RunCapAccounting {
  cap: RunTokenCap
  /** Tokens charged before a turn is sent (e.g. an estimate of the request). */
  before?(messages: EngineMessage[]): number
  /** Tokens charged after a turn returns. */
  after(result: TurnResult, messages: EngineMessage[]): number
}

export interface ToolLoopOptions {
  provider: ChatProvider
  /** Conversation so far; mutated in place as turns and tool results are added. */
  messages: EngineMessage[]
  tools: ToolSpec[]
  maxTurns: number
  hooks: ToolLoopHooks
  signal?: AbortSignal
  /** Yield text the model sent alongside tool calls (non-streaming providers). */
  emitTextWithToolCalls?: boolean
  /** Tools that may run concurrently within one turn (announced first, results in order). */
  parallelSafe?(name: string): boolean
  /** Content stored for an assistant turn that made tool calls (default: text ?? ''). */
  assistantContent?(text: string | null): string | null
  /** Include the tool name on tool-result messages. */
  toolMessageName?: boolean
  /** Only treat tool calls as such when finish_reason is 'tool_calls'. */
  toolCallsRequireFinishReason?: boolean
  runCap?: RunCapAccounting
  /** Accumulate usage here (readable by the caller even if the loop throws). */
  usage?: LoopUsage
}

export type LoopEndReason = 'final' | 'max_turns' | 'cap'

export interface LoopUsage extends TokenUsage {
  /** Whether the provider reported usage on any turn. */
  reported: boolean
  /** Input tokens of the most recent turn that reported usage. */
  lastInputTokens?: number
}

export type LoopEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; tool: string; args: string }
  | { type: 'tool_result'; id: string; tool: string; result: string }
  | { type: 'end'; reason: LoopEndReason; finalText: string | null; usage: LoopUsage; empty?: boolean }

export async function* runToolLoop(opts: ToolLoopOptions): AsyncGenerator<LoopEvent> {
  const { provider, messages, hooks } = opts
  const assistantContent = opts.assistantContent ?? ((t: string | null) => t ?? '')
  const usage: LoopUsage = opts.usage ?? { inputTokens: 0, outputTokens: 0, reported: false }
  let step = 0

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    throwIfAborted(opts.signal)
    if (opts.runCap?.cap.exceeded) {
      yield { type: 'end', reason: 'cap', finalText: null, usage }
      return
    }
    if (opts.runCap?.before) opts.runCap.cap.add(opts.runCap.before(messages))

    let result: TurnResult | undefined
    let streamed = false
    for await (const ev of provider.turn({ messages, tools: opts.tools, signal: opts.signal })) {
      if (ev.type === 'delta') {
        streamed = true
        yield { type: 'text', content: ev.text }
      } else {
        result = ev.result
      }
    }
    if (!result) throw new Error('Provider ended the turn without a result')

    if (result.usage) {
      usage.reported = true
      usage.inputTokens += result.usage.inputTokens
      usage.outputTokens += result.usage.outputTokens
      usage.lastInputTokens = result.usage.inputTokens
    }
    if (opts.runCap) opts.runCap.cap.add(opts.runCap.after(result, messages))

    if (result.empty) {
      yield { type: 'end', reason: 'final', finalText: null, usage, empty: true }
      return
    }

    const wantsTools = result.toolCalls.length > 0 &&
      (!opts.toolCallsRequireFinishReason || result.finishReason === 'tool_calls')

    if (!wantsTools) {
      const retry = hooks.reviewFinal?.(result.text) ?? null
      if (retry) {
        messages.push({ role: 'assistant', content: retry.assistant })
        messages.push({ role: 'user', content: retry.user })
        continue
      }
      if (!streamed && result.text) yield { type: 'text', content: result.text }
      yield { type: 'end', reason: 'final', finalText: result.text, usage }
      return
    }

    if (opts.emitTextWithToolCalls && !streamed && result.text) {
      yield { type: 'text', content: result.text }
    }
    messages.push({ role: 'assistant', content: assistantContent(result.text), toolCalls: result.toolCalls })

    const isParallel = (c: ToolCallRequest) => opts.parallelSafe?.(c.name) ?? false
    const parallel = result.toolCalls.filter(isParallel)
    const sequential = result.toolCalls.filter(c => !isParallel(c))

    const pushResult = (call: ToolCallRequest, content: string) => {
      messages.push({ role: 'tool', content, toolCallId: call.id, ...(opts.toolMessageName && { name: call.name }) })
    }
    const timed = async (call: ToolCallRequest, n: number) => {
      const t0 = Date.now()
      const r = await hooks.runTool(call, n)
      return { call, result: r, ms: Date.now() - t0 }
    }

    // Parallel-safe batch: announce every call before any of them runs.
    for (const call of parallel) {
      await hooks.beforeToolCall?.(call)
      yield { type: 'tool_call', id: call.id, tool: call.name, args: call.argsRaw }
    }
    const batch = await Promise.all(parallel.map(call => timed(call, ++step)))
    for (const { call, result: r, ms } of batch) {
      await hooks.afterToolResult?.(call, r, ms)
      yield { type: 'tool_result', id: call.id, tool: call.name, result: r }
      pushResult(call, r)
    }

    for (const call of sequential) {
      await hooks.beforeToolCall?.(call)
      yield { type: 'tool_call', id: call.id, tool: call.name, args: call.argsRaw }
      const { result: r, ms } = await timed(call, ++step)
      await hooks.afterToolResult?.(call, r, ms)
      yield { type: 'tool_result', id: call.id, tool: call.name, result: r }
      pushResult(call, r)
    }
  }

  yield { type: 'end', reason: 'max_turns', finalText: null, usage }
}

/** Keep the first and last messages of a long run, with a notice about what was dropped. */
export function trimHistory(messages: EngineMessage[], opts = { max: 40, keepFirst: 2, keepLast: 20 }): EngineMessage[] {
  if (messages.length <= opts.max) return messages
  const dropped = messages.length - opts.keepFirst - opts.keepLast
  return [
    ...messages.slice(0, opts.keepFirst),
    { role: 'system', content: `[${dropped} earlier messages trimmed to stay within context limits. Task is still in progress.]` },
    ...messages.slice(-opts.keepLast),
  ]
}

/** Wrap a provider so every turn sees a trimmed copy of the history (the full history is kept). */
export function withTrimmedHistory(provider: ChatProvider): ChatProvider {
  return {
    turn: req => provider.turn({ ...req, messages: trimHistory(req.messages) }),
  }
}
