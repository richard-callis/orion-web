/**
 * Regression tests for the vector-search correctness bugs found in the
 * pgvector audit:
 *  1. vectorSearch must use `<=>` (cosine distance), not `<->` (L2), and
 *     matching the HNSW index's `vector_cosine_ops`.
 *  2. ORDER BY/LIMIT must sit directly on the distance expression so the
 *     ANN index is usable — not on a derived `score` column.
 *  3. vectorSearch must filter by modelRef so vectors from different
 *     embedding providers are never compared against each other.
 *  4. generateEmbedding's Ollama path must read `data.embeddings[0]`
 *     (current /api/embed shape), not `data.embedding` (deprecated
 *     /api/embeddings shape) — and must fail loudly, not silently, when
 *     the field is missing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryRawCalls: Array<{ strings: TemplateStringsArray; values: unknown[] }> = []
const upsertCalls: Array<{ update: Record<string, unknown>; create: Record<string, unknown> }> = []
let externalModelFindMany: () => Promise<unknown[]> = async () => []

vi.mock('./db', () => ({
  prisma: {
    externalModel: {
      findMany: vi.fn(() => externalModelFindMany()),
    },
    noteEmbedding: {
      upsert: vi.fn(({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
        upsertCalls.push({ update, create })
        return Promise.resolve({})
      }),
      findUnique: vi.fn(() => Promise.resolve(null)),
    },
    $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      queryRawCalls.push({ strings, values })
      return Promise.resolve([])
    }),
  },
}))

vi.mock('./ssrf-guard', () => ({
  isPrivateUrl: vi.fn(() => Promise.resolve(false)),
}))

vi.mock('./sanitize-context', () => ({
  sanitizeContextNote: (title: string, content: string) => content,
}))

import { generateEmbedding, storeEmbedding, vectorSearch } from './embeddings'

beforeEach(() => {
  queryRawCalls.length = 0
  upsertCalls.length = 0
  externalModelFindMany = async () => []
  vi.restoreAllMocks()
})

describe('generateEmbedding — Ollama /api/embed field shape', () => {
  it('reads the plural `embeddings[0]` field from /api/embed, not `embedding`', async () => {
    externalModelFindMany = async () => [
      { provider: 'ollama', modelId: 'nomic-embed-text', baseUrl: 'http://ollama:11434', enabled: true },
    ]
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ model: 'nomic-embed-text', embeddings: [[0.1, 0.2, 0.3]] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateEmbedding('hello world')

    expect(result).not.toBeNull()
    expect(result?.vector).toEqual([0.1, 0.2, 0.3])
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/embed')
  })

  it('returns null and logs loudly when the expected `embeddings` field is missing', async () => {
    externalModelFindMany = async () => [
      { provider: 'ollama', modelId: 'nomic-embed-text', baseUrl: 'http://ollama:11434', enabled: true },
    ]
    // Simulate a response shaped like the deprecated /api/embeddings endpoint
    // (singular `embedding`) hitting the /api/embed code path.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    })))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateEmbedding('hello world')

    expect(result).toBeNull()
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('storeEmbedding — loud failure on invalid vectors', () => {
  it('throws instead of silently persisting an undefined/malformed vector', async () => {
    await expect(storeEmbedding('note-1', undefined as unknown as number[], 'nomic-embed-text'))
      .rejects.toThrow()
    await expect(storeEmbedding('note-1', [], 'nomic-embed-text'))
      .rejects.toThrow()
    await expect(storeEmbedding('note-1', [1, NaN, 3], 'nomic-embed-text'))
      .rejects.toThrow()
    expect(upsertCalls.length).toBe(0)
  })

  it('accepts a well-formed numeric vector', async () => {
    await storeEmbedding('note-1', [0.1, 0.2, 0.3], 'nomic-embed-text')
    expect(upsertCalls.length).toBe(1)
  })
})

describe('vectorSearch — query shape', () => {
  it('orders by the cosine-distance expression (<=>) directly, and filters by modelRef', async () => {
    await vectorSearch([0.1, 0.2, 0.3], 'nomic-embed-text', 5)

    expect(queryRawCalls.length).toBe(1)
    const sql = queryRawCalls[0].strings.join('?')

    // Bug #1: must use cosine distance, never L2.
    expect(sql).toContain('<=>')
    expect(sql).not.toContain('<->')

    // Bug #2: ORDER BY must be on the raw distance expression so the HNSW
    // index (vector_cosine_ops) is usable — not on a derived `score` alias.
    const orderByClause = sql.slice(sql.indexOf('ORDER BY'))
    expect(orderByClause.startsWith('ORDER BY ne.embedding <=>') || orderByClause.match(/^ORDER BY\s+ne\.embedding\s*<=>/)).toBeTruthy()
    expect(orderByClause).not.toMatch(/^ORDER BY\s+score/)

    // Bug #3: must filter by modelRef.
    expect(sql).toContain('"modelRef"')
    expect(queryRawCalls[0].values).toContain('nomic-embed-text')
  })
})
