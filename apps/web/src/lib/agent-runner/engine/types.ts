/**
 * Types for the single LLM engine: provider adapters speak these, and the one
 * shared tool loop (loop.ts) drives any provider through them.
 *
 * Every LLM entry point — worker task runners, human chat, chat-room agents,
 * dream and one-shot completions — builds on these instead of carrying its
 * own fetch/parse/tool-loop code.
 */

/** A tool call the model asked for, normalised across providers. */
export interface ToolCallRequest {
  id: string
  name: string
  /** Arguments as a JSON string (object arguments from Ollama are stringified). */
  argsRaw: string
  /** Provider-native arguments, echoed back verbatim in history (Ollama sends objects). */
  rawArguments?: unknown
}

export interface EngineMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** null is kept distinct from '' because some callers send null assistant content. */
  content: string | null
  toolCalls?: ToolCallRequest[]
  /** Tool-result messages: the call they answer. */
  toolCallId?: string
  /** Tool-result messages: the tool name (only sent by callers that opt in). */
  name?: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: object
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface TurnResult {
  /** Assistant text for the turn; null when the provider sent none. */
  text: string | null
  toolCalls: ToolCallRequest[]
  /** Only present when the provider reported it. */
  usage?: TokenUsage
  finishReason?: string
  /** The provider returned no choice/message at all. */
  empty?: boolean
}

export type TurnEvent =
  | { type: 'delta'; text: string }
  | { type: 'end'; result: TurnResult }

export interface TurnRequest {
  messages: EngineMessage[]
  tools: ToolSpec[]
  signal?: AbortSignal
}

/** One model call. Streaming providers yield `delta`s before the final `end`. */
export interface ChatProvider {
  turn(req: TurnRequest): AsyncGenerator<TurnEvent>
}

/** HTTP-level provider failure (non-2xx). Callers that swallow HTTP errors test for this class. */
export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message)
    this.name = 'ProviderHttpError'
  }
}
