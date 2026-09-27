/**
 * Provider adapter tests: wire formats in and out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeHttp, stream, openaiSSE, ollamaChat, json, text } from '../testing/fake-http'
import { createOpenAIProvider } from './providers/openai'
import { createOllamaProvider, buildOllamaOptions } from './providers/ollama'
import { ProviderHttpError, type TurnEvent, type TurnResult } from './types'

let http: FakeHttp
beforeEach(() => { http = new FakeHttp(); http.install() })
afterEach(() => vi.unstubAllGlobals())

async function turnOf(gen: AsyncGenerator<TurnEvent>): Promise<{ deltas: string[]; result: TurnResult }> {
  const deltas: string[] = []
  let result: TurnResult | undefined
  for await (const e of gen) e.type === 'delta' ? deltas.push(e.text) : (result = e.result)
  return { deltas, result: result! }
}

describe('OpenAI provider', () => {
  it('streaming: deltas, fragmented tool calls reassembled by index, default ids', async () => {
    http.route('/chat', stream(openaiSSE([
      { content: 'Let me ' },
      { tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{"x"' } }] },
      { tool_calls: [{ index: 1, function: { name: 'b', arguments: '{}' } }] },
      { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] },
    ])))
    const p = createOpenAIProvider({ url: 'http://o/chat', model: 'm', stream: true, timeoutMs: 1000 })
    const { deltas, result } = await turnOf(p.turn({ messages: [{ role: 'user', content: 'q' }], tools: [] }))
    expect(deltas).toEqual(['Let me '])
    expect(result).toEqual({
      text: 'Let me ',
      toolCalls: [{ id: 'c0', name: 'a', argsRaw: '{"x":1}' }, { id: 'tc_1', name: 'b', argsRaw: '{}' }],
    })
  })

  it('non-streaming: usage, finish reason, object arguments stringified; empty choice flagged', async () => {
    http.route('/chat',
      json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'i', function: { name: 'n', arguments: { a: 1 } } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      json({ choices: [] }),
    )
    const p = createOpenAIProvider({ url: 'http://o/chat', model: 'm', stream: false, timeoutMs: 1000 })
    expect((await turnOf(p.turn({ messages: [], tools: [] }))).result).toEqual({
      text: null, toolCalls: [{ id: 'i', name: 'n', argsRaw: '{"a":1}' }], usage: { inputTokens: 3, outputTokens: 2 }, finishReason: 'tool_calls',
    })
    expect((await turnOf(p.turn({ messages: [], tools: [] }))).result.empty).toBe(true)
  })

  it('wire messages and tools; empty tool list omitted unless sendEmptyTools', async () => {
    http.route('/chat', json({ choices: [{ message: { content: 'k' } }] }), json({ choices: [{ message: { content: 'k' } }] }))
    const p = createOpenAIProvider({ url: 'http://o/chat', apiKey: 'K', model: 'm', stream: false, timeoutMs: 1000, extraBody: { think: false } })
    await turnOf(p.turn({
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 't', argsRaw: '{}' }] },
        { role: 'tool', content: 'r', toolCallId: 'x' },
      ],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    }))
    const body = http.calls[0].body as Record<string, unknown>
    expect(body).toEqual({
      model: 'm', stream: false, think: false,
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', content: 'r', tool_call_id: 'x' },
      ],
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }],
    })
    expect(http.calls[0].headers.authorization).toBe('Bearer K')
    const p2 = createOpenAIProvider({ url: 'http://o/chat', model: 'm', stream: false, timeoutMs: 1000, sendEmptyTools: true })
    await turnOf(p2.turn({ messages: [], tools: [] }))
    expect((http.calls[1].body as Record<string, unknown>).tools).toEqual([])
  })

  it('HTTP errors are ProviderHttpError with the configured message', async () => {
    http.route('/chat', text('nope', 429))
    const p = createOpenAIProvider({ url: 'http://o/chat', model: 'm', stream: false, timeoutMs: 1000, httpErrorMessage: (s, b) => `X ${s} ${b}` })
    const err = await turnOf(p.turn({ messages: [], tools: [] })).catch(e => e)
    expect(err).toBeInstanceOf(ProviderHttpError)
    expect(err).toMatchObject({ message: 'X 429 nope', status: 429, body: 'nope' })
  })
})

describe('Ollama provider', () => {
  it('object arguments are stringified for events and echoed natively in history', async () => {
    http.route('/api/chat',
      ollamaChat({ content: 'p', tool_calls: [{ name: 'k', arguments: { ns: 'x' } }] }, { prompt_eval_count: 7, eval_count: 3 }),
      ollamaChat({ content: 'ok' }),
    )
    const p = createOllamaProvider({ baseUrl: 'http://ol', model: 'm', stream: false, timeoutMs: 1000, options: buildOllamaOptions({ temperature: 0.2 }) })
    const first = (await turnOf(p.turn({ messages: [], tools: [] }))).result
    expect(first).toEqual({
      text: 'p',
      toolCalls: [{ id: 'ollama_0', name: 'k', argsRaw: '{"ns":"x"}', rawArguments: { ns: 'x' } }],
      usage: { inputTokens: 7, outputTokens: 3 },
    })
    await turnOf(p.turn({ messages: [{ role: 'assistant', content: 'p', toolCalls: first.toolCalls }, { role: 'tool', content: 'r', toolCallId: 'ollama_0' }], tools: [] }))
    expect(http.calls[1].body).toEqual({
      model: 'm', stream: false, options: { temperature: 0.2 },
      messages: [
        { role: 'assistant', content: 'p', tool_calls: [{ function: { name: 'k', arguments: { ns: 'x' } } }] },
        { role: 'tool', content: 'r' },
      ],
    })
  })

  it('buildOllamaOptions omits unset fields', () => {
    expect(buildOllamaOptions({})).toBeUndefined()
    expect(buildOllamaOptions({ topP: 0.9, seed: 0, minP: null })).toEqual({ top_p: 0.9, seed: 0 })
  })
})
