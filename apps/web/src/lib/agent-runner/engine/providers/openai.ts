/**
 * OpenAI-compatible provider adapter (/chat/completions): OpenAI, llama.cpp,
 * vLLM, LM Studio, Ollama's /v1 endpoint and Anthropic's compat endpoint.
 * Supports both non-streaming turns and SSE streaming (text deltas + tool-call
 * fragments reassembled by index).
 */
import { runSignal } from '../../abort'
import { ProviderHttpError, type ChatProvider, type EngineMessage, type ToolCallRequest, type ToolSpec, type TurnEvent, type TurnRequest, type TurnResult } from '../types'

export interface OpenAIProviderConfig {
  /** Full completions URL, e.g. `${baseUrl}/v1/chat/completions`. */
  url: string
  apiKey?: string | null
  model: string
  stream: boolean
  timeoutMs: number
  /** Extra request fields (max_tokens, temperature, top_p, seed, think…). */
  extraBody?: Record<string, unknown>
  /** Send `tools: []` when the caller passes an empty list (default: omit). */
  sendEmptyTools?: boolean
  /** Error text for a non-2xx response. */
  httpErrorMessage?: (status: number, body: string) => string
}

type WireToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type WireMessage = { role: string; content: string | null; tool_calls?: WireToolCall[]; tool_call_id?: string; name?: string }

export function toOpenAIMessages(messages: EngineMessage[]): WireMessage[] {
  return messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId, ...(m.name !== undefined && { name: m.name }) }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.argsRaw } })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

export function toOpenAITools(tools: ToolSpec[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }> {
  return tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }))
}

interface CompletionResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string | Record<string, unknown> } }> }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
  }>
}

export function createOpenAIProvider(cfg: OpenAIProviderConfig): ChatProvider {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const httpError = cfg.httpErrorMessage ?? ((s: number, b: string) => `OpenAI ${s}: ${b}`)

  return {
    async *turn(req: TurnRequest): AsyncGenerator<TurnEvent> {
      const body: Record<string, unknown> = { model: cfg.model, messages: toOpenAIMessages(req.messages), stream: cfg.stream }
      if (req.tools.length > 0 || cfg.sendEmptyTools) body.tools = toOpenAITools(req.tools)
      Object.assign(body, cfg.extraBody)

      const res = await fetch(cfg.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: runSignal(req.signal, cfg.timeoutMs),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new ProviderHttpError(httpError(res.status, text), res.status, text)
      }

      if (!cfg.stream) {
        yield { type: 'end', result: parseCompletion(await res.json() as CompletionResponse) }
        return
      }

      if (!res.body) throw new Error('No response body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let text = ''
      const pending: Array<{ id: string; name: string; argsRaw: string }> = []
      // Release the upstream stream on any early exit (error, consumer stopped)
      try {
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
            let chunk: StreamChunk
            try { chunk = JSON.parse(data) as StreamChunk } catch { continue }
            const delta = chunk.choices?.[0]?.delta
            if (!delta) continue
            if (delta.content) {
              text += delta.content
              yield { type: 'delta', text: delta.content }
            }
            for (const tc of delta.tool_calls ?? []) {
              const slot = pending[tc.index] ??= { id: tc.id ?? `tc_${tc.index}`, name: tc.function?.name ?? '', argsRaw: '' }
              if (tc.function?.name) slot.name = tc.function.name
              if (tc.function?.arguments) slot.argsRaw += tc.function.arguments
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {})
      }
      const toolCalls: ToolCallRequest[] = pending.filter(Boolean).map(p => ({ id: p.id, name: p.name, argsRaw: p.argsRaw }))
      yield { type: 'end', result: { text, toolCalls } }
    },
  }
}

function parseCompletion(data: CompletionResponse): TurnResult {
  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
    : undefined
  const choice = data.choices?.[0]
  if (!choice?.message) return { text: null, toolCalls: [], usage, empty: true }
  const toolCalls: ToolCallRequest[] = (choice.message.tool_calls ?? []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    argsRaw: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
  }))
  return { text: choice.message.content ?? null, toolCalls, usage, finishReason: choice.finish_reason }
}
