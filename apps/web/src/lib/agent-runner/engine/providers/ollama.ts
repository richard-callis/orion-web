/**
 * Ollama native provider adapter (/api/chat). Non-streaming turns carry tool
 * calls; streaming (NDJSON) is used for plain chat without tools.
 */
import { runSignal } from '../../abort'
import { ProviderHttpError, type ChatProvider, type EngineMessage, type ToolCallRequest, type TurnEvent, type TurnRequest } from '../types'
import { toOpenAITools } from './openai'

export interface OllamaProviderConfig {
  baseUrl: string
  model: string
  stream: boolean
  timeoutMs: number
  /** Sampling options (temperature, top_p, …); omitted when empty. */
  options?: Record<string, number>
}

type WireMessage = { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }

interface OllamaChatResponse {
  message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: string | Record<string, unknown> } }> }
  prompt_eval_count?: number
  eval_count?: number
}

function toOllamaMessages(messages: EngineMessage[]): WireMessage[] {
  return messages.map(m => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.rawArguments ?? tc.argsRaw } })),
      }
    }
    return { role: m.role, content: m.content ?? '' }
  })
}

/** Ollama sampling options from optional per-model settings; undefined when none are set. */
export function buildOllamaOptions(s: {
  temperature?: number | null; topP?: number | null; minP?: number | null; repeatPenalty?: number | null; seed?: number | null
}): Record<string, number> | undefined {
  const opts: Record<string, number> = {}
  if (s.temperature   != null) opts.temperature    = s.temperature
  if (s.topP          != null) opts.top_p          = s.topP
  if (s.minP          != null) opts.min_p          = s.minP
  if (s.repeatPenalty != null) opts.repeat_penalty = s.repeatPenalty
  if (s.seed          != null) opts.seed           = s.seed
  return Object.keys(opts).length ? opts : undefined
}

export function createOllamaProvider(cfg: OllamaProviderConfig): ChatProvider {
  return {
    async *turn(req: TurnRequest): AsyncGenerator<TurnEvent> {
      const body: Record<string, unknown> = { model: cfg.model, messages: toOllamaMessages(req.messages), stream: cfg.stream }
      if (req.tools.length > 0) body.tools = toOpenAITools(req.tools)
      if (cfg.options) body.options = cfg.options

      const res = await fetch(`${cfg.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: runSignal(req.signal, cfg.timeoutMs),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new ProviderHttpError(`Ollama ${res.status}: ${text}`, res.status, text)
      }

      if (!cfg.stream) {
        const data = await res.json() as OllamaChatResponse
        const toolCalls: ToolCallRequest[] = (data.message?.tool_calls ?? []).map((tc, i) => ({
          id: `ollama_${i}`,
          name: tc.function.name,
          argsRaw: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
          rawArguments: tc.function.arguments,
        }))
        const reported = data.prompt_eval_count !== undefined || data.eval_count !== undefined
        yield {
          type: 'end',
          result: {
            text: data.message?.content ?? null,
            toolCalls,
            ...(reported && { usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 } }),
          },
        }
        return
      }

      if (!res.body) throw new Error('No response body from Ollama')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let text = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            let chunk: { message?: { content?: string } }
            try { chunk = JSON.parse(line) as { message?: { content?: string } } } catch { continue }
            const t = chunk.message?.content ?? ''
            if (t) {
              text += t
              yield { type: 'delta', text: t }
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {})
      }
      yield { type: 'end', result: { text, toolCalls: [] } }
    },
  }
}
