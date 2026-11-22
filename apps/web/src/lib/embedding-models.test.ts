import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), setting: vi.fn(), upsert: vi.fn(), fetch: vi.fn() }))
vi.mock('./db', () => ({ prisma: {
  externalModel: { findMany: m.findMany, findUnique: m.findUnique, findFirst: m.findFirst },
  systemSetting: { findUnique: m.setting, upsert: m.upsert },
} }))
vi.mock('./ssrf-guard', () => ({ isPrivateUrl: vi.fn(async () => false) }))
vi.mock('./auth', () => ({ requireAdmin: vi.fn(async () => ({ id: 'a' })) }))

import { CHAT_MODELS, chatModelChoice, isEmbeddingModel } from './embedding-models'
import { generateEmbedding } from './embeddings'
import { getDefaultModelId } from './default-model'
import { PUT } from '@/app/api/admin/models/default/route'
import { isRefusedDefault } from './embedding-models'
import { resolveModelId } from '@/worker/model'

const EMBEDDING = ['nomic-embed-text', 'nomic-embed-text:latest', 'text-embedding-3-small', 'mxbai-embed-large', 'bge-m3', 'BAAI/bge-m3', 'hf.co/org/bge-m3-GGUF', 'all-minilm', 'gte-large', 'Alibaba-NLP/gte-large-en', 'E5-large', 'intfloat/e5-large-v2', 'multilingual-e5-base', 'yxchia/multilingual-e5-base', 'paraphrase-multilingual']
const CHAT = ['default', 'llama3.1:8b', 'qwen2.5:0.5b', 'minicpm-v:latest', 'gpt-4o', 'moondream']

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  vi.stubGlobal('fetch', m.fetch)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return () => { vi.unstubAllGlobals(); vi.restoreAllMocks() }
})

describe('isEmbeddingModel', () => {
  it.each(EMBEDDING)('%s', id => expect(isEmbeddingModel(id)).toBe(true))
  it.each(CHAT)('not %s', id => expect(isEmbeddingModel(id)).toBe(false))
  it('has a Prisma filter with the same rules, case included', () => {
    const excluded = (id: string) => CHAT_MODELS.NOT.OR.some(({ modelId: r }) => {
      const fold = (s: string) => (r.mode === 'insensitive' ? s.toLowerCase() : s)
      return 'contains' in r ? fold(id).includes(fold(r.contains)) : fold(id).startsWith(fold(r.startsWith))
    })
    for (const id of EMBEDDING) expect([id, excluded(id)]).toEqual([id, true])
    for (const id of CHAT) expect([id, excluded(id)]).toEqual([id, false])
  })
})

describe('stored choices', () => {
  it('ignores one that names an embedding model, in either form', async () => {
    m.findUnique.mockResolvedValue({ modelId: 'nomic-embed-text' })
    expect(await chatModelChoice('ext:abc', 's')).toBeUndefined()
    expect(await chatModelChoice('abc', 's')).toBeUndefined()
    expect(m.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'abc' } }))
    expect(await chatModelChoice('ollama:nomic-embed-text', 's')).toBeUndefined()
  })
  it('recognises a bare Ollama name, but not an unknown ext id', async () => {
    m.findUnique.mockResolvedValue(null)
    expect(await chatModelChoice('nomic-embed-text', 's')).toBeUndefined()
    expect(await chatModelChoice('ext:embed-something', 's')).toBe('ext:embed-something')
  })
  it('refuses one as any default setting, and only there', async () => {
    m.findUnique.mockResolvedValue({ modelId: 'nomic-embed-text' })
    for (const key of ['model.default', 'ai.default-model', 'dream.model']) expect(await isRefusedDefault(key, 'abc')).toBe(true)
    expect(await isRefusedDefault('embedding.model', 'abc')).toBe(false)
    expect(await isRefusedDefault('model.default', '')).toBe(false)
  })
  it("the worker refuses an agent's embedding model instead of replacing it", async () => {
    m.findUnique.mockResolvedValue({ modelId: 'nomic-embed-text' })
    await expect(resolveModelId('ext:abc')).rejects.toThrow("can't chat")
    await expect(resolveModelId('abc')).rejects.toThrow("can't chat")
    m.findUnique.mockResolvedValue({ modelId: 'llama3.1:8b' })
    expect(await resolveModelId('abc')).toBe('ext:abc')
  })
  it('the worker does not use an embedding model as the default', async () => {
    m.setting.mockResolvedValue({ value: 'ext:abc' })
    m.findUnique.mockResolvedValue({ modelId: 'nomic-embed-text' })
    await expect(resolveModelId(undefined)).rejects.toThrow('No default LLM')
  })
  it('keeps chat models, built-ins and unknown ids', async () => {
    m.findUnique.mockResolvedValueOnce({ modelId: 'llama3.1:8b' }).mockResolvedValueOnce(null)
    expect(await chatModelChoice('ext:abc', 's')).toBe('ext:abc')
    expect(await chatModelChoice('gone', 's')).toBe('gone')
    expect(await chatModelChoice('claude:x', 's')).toBe('claude:x')
    expect(await chatModelChoice(null, 's')).toBeUndefined()
  })
  it('the default model falls through to the first chat model', async () => {
    m.setting.mockResolvedValue({ value: 'ext:abc' })
    m.findUnique.mockResolvedValue({ modelId: 'nomic-embed-text' })
    m.findFirst.mockResolvedValue({ id: 'chat' })
    expect(await getDefaultModelId()).toBe('chat')
    expect(m.findFirst.mock.calls[0][0].where).toEqual({ enabled: true, ...CHAT_MODELS })
  })
  it('an embedding model cannot be made the default', async () => {
    m.findUnique.mockResolvedValue({ modelId: 'nomic-embed-text' })
    const put = (modelId: string) => PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify({ modelId }) }) as never)
    expect((await put('ext:abc')).status).toBe(400)
    expect(m.upsert).not.toHaveBeenCalled()
    m.findUnique.mockResolvedValue({ modelId: 'llama3.1:8b' })
    expect((await put('ext:abc')).status).toBe(200)
  })
})

describe('generateEmbedding', () => {
  const ollama = (modelId: string) => ({ provider: 'ollama', baseUrl: 'http://ollama:11434', modelId })
  const ok = () => new Response(JSON.stringify({ embeddings: [[1, 2]] }))
  const sent = () => m.fetch.mock.calls.map(c => JSON.parse(c[1].body).input.length)

  it('prefers an embedding model over an earlier chat model', async () => {
    m.findMany.mockResolvedValue([ollama('llama3.1:8b'), ollama('nomic-embed-text')])
    m.fetch.mockImplementation(async () => ok())
    expect((await generateEmbedding('x'))?.modelRef).toBe('nomic-embed-text')
  })
  it('still uses the only Ollama model when none is named like one', async () => {
    m.findMany.mockResolvedValue([ollama('my-vectors')])
    m.fetch.mockImplementation(async () => ok())
    expect((await generateEmbedding('x'))?.modelRef).toBe('my-vectors')
  })
  it('shortens a text the model refuses as too long', async () => {
    m.findMany.mockResolvedValue([ollama('nomic-embed-text')])
    m.fetch.mockImplementation(async (_u: string, init: { body: string }) =>
      JSON.parse(init.body).input.length > 4000 ? new Response('{"error":"the input length exceeds the context length"}', { status: 400 }) : ok())
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await generateEmbedding('x'.repeat(6286))).not.toBeNull()
    expect(sent()).toEqual([6286, 4714, 3535])
  })
  it('does not retry any other refusal, and logs why', async () => {
    m.findMany.mockResolvedValue([ollama('nomic-embed-text')])
    m.fetch.mockImplementation(async () => new Response('{"error":"this model does not support embeddings"}', { status: 400 }))
    expect(await generateEmbedding('x'.repeat(6000))).toBeNull()
    expect(sent()).toEqual([6000])
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('does not support embeddings')
  })
  it('stops at the shortest text worth embedding', async () => {
    m.findMany.mockResolvedValue([ollama('nomic-embed-text')])
    m.fetch.mockImplementation(async () => new Response('the input length exceeds the context length', { status: 400 }))
    expect(await generateEmbedding('x'.repeat(700))).toBeNull()
    expect(sent()).toEqual([700, 525, 500])
  })
})
