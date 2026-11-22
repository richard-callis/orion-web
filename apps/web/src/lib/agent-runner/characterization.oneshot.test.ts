/**
 * Characterization tests for one-shot completions: callDefaultModel
 * (default-model.ts) and dream's callWithModel. Pins provider routing,
 * request shapes, returned text/usage and error texts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeHttp, json, text } from './testing/fake-http'

const h = vi.hoisted(() => ({
  prisma: {
    systemSetting: { findUnique: vi.fn() },
    externalModel: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/db', () => ({ prisma: h.prisma }))

import { callDefaultModel } from '../default-model'
import { callWithModel } from '../dream'

let http: FakeHttp
beforeEach(() => {
  http = new FakeHttp()
  http.install()
  h.prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null)
  h.prisma.externalModel.findUnique.mockReset()
  h.prisma.externalModel.findFirst.mockReset().mockResolvedValue(null)
})
afterEach(() => vi.unstubAllGlobals())

describe('callDefaultModel', () => {
  it('OpenAI-compatible default: single user message, trimmed text', async () => {
    h.prisma.systemSetting.findUnique.mockResolvedValue({ value: 'ext:m1' })
    h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'm1', provider: 'custom', baseUrl: 'http://llm.test', modelId: 'm', apiKey: 'k', timeoutSecs: 10 })
    http.route('/v1/chat/completions', json({ choices: [{ message: { content: '  answer ' } }] }))
    expect(await callDefaultModel('Q')).toBe('answer')
    const [call] = http.calls
    expect(call.url).toBe('http://llm.test/v1/chat/completions')
    expect(call.headers.authorization).toBe('Bearer k')
    expect(call.body).toEqual({ model: 'm', stream: false, messages: [{ role: 'user', content: 'Q' }] })
    expect(h.prisma.externalModel.findUnique).toHaveBeenCalledWith({ where: { id: 'm1' } })
  })

  it('Ollama default: /api/generate', async () => {
    h.prisma.systemSetting.findUnique.mockResolvedValue({ value: 'm2' })
    h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'm2', provider: 'ollama', baseUrl: 'http://ollama.test', modelId: 'llama3' })
    http.route('/api/generate', json({ response: ' hi ' }))
    expect(await callDefaultModel('Q')).toBe('hi')
    expect(http.calls[0].body).toEqual({ model: 'llama3', prompt: 'Q', stream: false })
  })

  it('errors: missing model, HTTP failure, empty reply', async () => {
    h.prisma.systemSetting.findUnique.mockResolvedValue({ value: 'gone' })
    h.prisma.externalModel.findUnique.mockResolvedValueOnce(null)
    await expect(callDefaultModel('Q')).rejects.toThrow("Default model 'gone' not found — configure one in Settings → AI")

    h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'm', provider: 'openai', baseUrl: 'http://llm.test', modelId: 'm' })
    http.route('/v1/chat/completions', text('overloaded', 529), json({ choices: [{ message: { content: '' } }] }))
    await expect(callDefaultModel('Q')).rejects.toThrow('Model API returned HTTP 529: overloaded')
    await expect(callDefaultModel('Q')).rejects.toThrow('Model returned an empty response')
  })
})

describe('dream callWithModel', () => {
  it('claude: sidecar collect, one turn, usage estimated when absent', async () => {
    http.route('/run/collect', json({ text: 'notes' }))
    const r = await callWithModel('claude:claude-x', 'extract this')
    expect(r.text).toBe('notes')
    expect(r.inputTokens).toBeGreaterThan(0)
    expect(http.calls[0].body).toEqual({
      prompt: 'extract this', model: 'claude-x', maxTurns: 1,
      // Structured fields added by the engine consolidation; one-shots run with no tools
      messages: [{ role: 'user', content: 'extract this' }],
      allowedTools: [],
    })
  })

  it('OpenAI-compatible: returns reasoning_content and reported usage', async () => {
    h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'x', provider: 'custom', baseUrl: 'http://llm.test', modelId: 'r1', apiKey: null, timeoutSecs: 5 })
    http.route('/v1/chat/completions', json({
      choices: [{ message: { content: ' out ', reasoning_content: ' why ' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }))
    expect(await callWithModel('x', 'p')).toEqual({ text: 'out', inputTokens: 3, outputTokens: 4, reasoning: 'why' })
  })

  describe('direct (no reasoning, JSON schema)', () => {
    const opts = { maxTokens: 50, direct: { schema: { type: 'object' } } }
    const model = (provider: string) => h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'x', provider, baseUrl: 'http://llm.test', modelId: 'r1', apiKey: null, timeoutSecs: 5 })
    const ok = json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: {} })

    it('custom endpoints get both fields and the token limit', async () => {
      model('custom')
      http.route('/v1/chat/completions', ok)
      await callWithModel('x', 'p', opts)
      expect(http.calls[0].body).toEqual({
        model: 'r1', stream: false, messages: [{ role: 'user', content: 'p' }], max_tokens: 50,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: { type: 'object' } } },
      })
    })

    it('asks again plainly, without the limit, when an endpoint rejects the request', async () => {
      for (const [provider, status] of [['openai', 400], ['custom', 422], ['openrouter', 500]] as const) {
        http.calls.length = 0
        model(provider)
        http.route('/v1/chat/completions', text('use max_completion_tokens', status), ok)
        expect((await callWithModel('x', 'p', opts)).text).toBe('{}')
        expect(http.calls).toHaveLength(2)
        expect(http.calls[1].body).toEqual({ model: 'r1', stream: false, messages: [{ role: 'user', content: 'p' }] })
      }
    })

    it("stays within the model's own token limit", async () => {
      h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'x', provider: 'custom', baseUrl: 'http://llm.test', modelId: 'r1', maxTokens: 20 })
      http.route('/v1/chat/completions', ok)
      await callWithModel('x', 'p', opts)
      expect(http.calls[0].body).toMatchObject({ max_tokens: 20 })
    })

    it('Ollama: think off, the schema as format, num_predict; done_reason length is a cut-off', async () => {
      h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'o', provider: 'ollama', baseUrl: 'http://ollama.test', modelId: 'llama3' })
      http.route('/api/generate', json({ response: 'r', done_reason: 'length' }))
      expect((await callWithModel('o', 'p', opts)).truncated).toBe(true)
      expect(http.calls[0].body).toEqual({ model: 'llama3', prompt: 'p', stream: false, think: false, format: { type: 'object' }, options: { num_predict: 50 } })
    })

    it('does not retry other failures, and reports a cut-off reply', async () => {
      model('custom')
      http.route('/v1/chat/completions', text('busy', 503), json({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }))
      await expect(callWithModel('x', 'p', opts)).rejects.toThrow('503')
      expect((await callWithModel('x', 'p', opts)).truncated).toBe(true)
    })
  })

  it('Ollama: /api/generate with eval counts', async () => {
    h.prisma.externalModel.findUnique.mockResolvedValue({ id: 'o', provider: 'ollama', baseUrl: 'http://ollama.test', modelId: 'llama3' })
    http.route('/api/generate', json({ response: 'r', prompt_eval_count: 8, eval_count: 2 }))
    expect(await callWithModel('o', 'p')).toEqual({ text: 'r', inputTokens: 8, outputTokens: 2 })
  })

  it('errors', async () => {
    h.prisma.externalModel.findUnique.mockResolvedValue(null)
    await expect(callWithModel('nope', 'p')).rejects.toThrow("dream.model 'nope' not found")
    http.route('/run/collect', text('x', 502))
    await expect(callWithModel('claude', 'p')).rejects.toThrow('orion-claude HTTP 502')
  })
})
