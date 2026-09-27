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

import {
  generateEmbedding,
  storeEmbedding,
  vectorSearch,
  hybridSearch,
  mapHybridRows,
  filterRelevantHits,
  ownerFilterWhere,
  type HybridSearchHit,
} from './embeddings'

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

describe('hybridSearch — RRF fusion of vector + full-text legs', () => {
  it('runs both legs and fuses via RRF when an embedding provider is configured', async () => {
    externalModelFindMany = async () => [
      { provider: 'ollama', modelId: 'nomic-embed-text', baseUrl: 'http://ollama:11434', enabled: true },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    })))

    const { modelRef, hits } = await hybridSearch('crashloopbackoff pod-7f9', 10)

    expect(modelRef).toBe('nomic-embed-text')
    expect(hits).toEqual([])
    expect(queryRawCalls.length).toBe(1)
    const sql = queryRawCalls[0].strings.join('?')

    // Both legs present.
    expect(sql).toContain('<=>')
    expect(sql).toContain('websearch_to_tsquery')
    expect(sql).toContain('ts_rank_cd')
    // RRF fusion, not a naive union/intersection.
    expect(sql).toMatch(/1\.0\s*\/\s*\(\?\s*\+\s*vec\.rnk\)/)
    expect(sql).toContain('FULL OUTER JOIN')
    // Vector leg still respects the modelRef isolation fix.
    expect(sql).toContain('"modelRef"')
    expect(queryRawCalls[0].values).toContain('nomic-embed-text')
    // websearch_to_tsquery (not plainto_tsquery) so callers can use quoted phrases.
    expect(sql).not.toContain('plainto_tsquery')
  })

  it('falls back to keyword-only search when no embedding provider is configured', async () => {
    externalModelFindMany = async () => []

    const { modelRef, hits } = await hybridSearch('crashloopbackoff pod-7f9', 10)

    expect(modelRef).toBeNull()
    expect(hits).toEqual([])
    expect(queryRawCalls.length).toBe(1)
    const sql = queryRawCalls[0].strings.join('?')
    expect(sql).toContain('websearch_to_tsquery')
    expect(sql).not.toContain('<=>')
  })

  it('adds a secondary `n.id` sort tiebreak so RRF ties order deterministically (keyword-only fallback)', async () => {
    externalModelFindMany = async () => []
    await hybridSearch('crashloopbackoff pod-7f9', 10)
    const sql = queryRawCalls[0].strings.join('?')
    expect(sql).toMatch(/ORDER BY score DESC,\s*n\.id/)
  })

  it('adds a secondary `n.id` sort tiebreak so RRF ties order deterministically (primary hybrid query)', async () => {
    externalModelFindMany = async () => [
      { provider: 'ollama', modelId: 'nomic-embed-text', baseUrl: 'http://ollama:11434', enabled: true },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    })))

    await hybridSearch('crashloopbackoff pod-7f9', 10)
    const sql = queryRawCalls[0].strings.join('?')
    expect(sql).toMatch(/ORDER BY fused\.score DESC,\s*n\.id/)
  })

  it('omits the ownership predicate for a trusted/unscoped caller (no callerId)', async () => {
    externalModelFindMany = async () => []
    await hybridSearch('crashloopbackoff pod-7f9', 10)
    const sql = queryRawCalls[0].strings.join('?')
    expect(sql).not.toContain('"createdBy"')
  })

  it('adds a createdBy ownership predicate to both legs when a callerId is passed (access-control fix)', async () => {
    externalModelFindMany = async () => [
      { provider: 'ollama', modelId: 'nomic-embed-text', baseUrl: 'http://ollama:11434', enabled: true },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    })))

    await hybridSearch('crashloopbackoff pod-7f9', 10, 'user-123')

    expect(queryRawCalls.length).toBe(1)
    const sql = queryRawCalls[0].strings.join('?')
    const values = queryRawCalls[0].values

    // $queryRaw composes nested `Prisma.sql` fragments (the ownerFilter) as
    // opaque Sql objects in `values`, not inlined text — so pull the
    // fragment's own text/values back out to assert on it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownerFragment = values.find((v: any) => v && typeof v === 'object' && 'strings' in v) as any
    expect(ownerFragment).toBeDefined()
    expect(ownerFragment.text).toContain('n."createdBy" IS NULL OR')
    expect(ownerFragment.text).toContain('n."createdBy" =')
    expect(ownerFragment.values).toContain('user-123')

    // Both the keyword (kw_top) and vector (vec_top) CTEs must reference the
    // owner-filter placeholder — not just one leg. A regular logged-in user
    // must never be able to reach every row in Note via either leg.
    const ownerFilterUses = values.filter((v: any) => v === ownerFragment).length
    expect(ownerFilterUses).toBe(2)

    // vec_top must join Note to apply the predicate at all.
    expect(sql).toMatch(/FROM "note_embeddings" ne\s+JOIN "Note" n ON n\.id = ne\."noteId"/)
  })
})

describe('ownerFilterWhere — Prisma Client query-builder equivalent of ownerFilterSql', () => {
  it('returns an empty where clause for a trusted/unscoped caller (no callerId)', () => {
    expect(ownerFilterWhere(undefined)).toEqual({})
  })

  it('restricts to the caller\'s own notes plus unowned/shared (createdBy: null) notes', () => {
    expect(ownerFilterWhere('user-123')).toEqual({
      OR: [{ createdBy: null }, { createdBy: 'user-123' }],
    })
  })
})

describe('mapHybridRows — raw SQL row → HybridSearchHit mapping', () => {
  it('parses numeric-string scores and nulls from $queryRaw rows', () => {
    const hits = mapHybridRows([
      {
        noteId: 'n1', title: 'Title', content: 'Body', type: 'note', folder: 'root', pinned: false,
        score: '0.0163934', vectorScore: null, keywordScore: '0.5',
      },
      {
        noteId: 'n2', title: 'Title 2', content: 'Body 2', type: 'note', folder: 'root', pinned: true,
        score: '0.032', vectorScore: '0.81', keywordScore: null,
      },
    ])

    expect(hits).toEqual([
      { noteId: 'n1', title: 'Title', content: 'Body', type: 'note', folder: 'root', pinned: false, score: 0.0163934, vectorScore: null, keywordScore: 0.5 },
      { noteId: 'n2', title: 'Title 2', content: 'Body 2', type: 'note', folder: 'root', pinned: true, score: 0.032, vectorScore: 0.81, keywordScore: null },
    ])
  })
})

// Regression tests for #717-class bugs: minScore must actually gate results,
// and a non-null keywordScore must not unconditionally bypass relevance
// filtering (the "minScore is effectively inoperative" finding).
describe('filterRelevantHits — retrieveKnowledgeContext relevance filter', () => {
  const hit = (overrides: Partial<HybridSearchHit>): HybridSearchHit => ({
    noteId: 'n', title: 't', content: 'c', type: 'note', folder: 'root', pinned: false,
    score: 0.01, vectorScore: null, keywordScore: null,
    ...overrides,
  })

  it('keeps a hit with only a strong keywordScore, regardless of minScore', () => {
    const h = hit({ keywordScore: 0.5, vectorScore: null })
    expect(filterRelevantHits([h], 0.9)).toEqual([h])
  })

  it('drops a hit with only a keywordScore below minKeywordScore (the #717-class regression)', () => {
    const h = hit({ keywordScore: 0.001, vectorScore: null })
    // Even with minScore set permissively low, a marginal keyword hit must
    // not sail through unconditionally — this is exactly the bug: any
    // non-null keywordScore used to bypass minScore entirely.
    expect(filterRelevantHits([h], 0, 0.01)).toEqual([])
  })

  it('keeps a hit with only vectorScore set when it is above minScore', () => {
    const h = hit({ keywordScore: null, vectorScore: 0.5 })
    expect(filterRelevantHits([h], 0.4)).toEqual([h])
  })

  it('drops a hit with only vectorScore set when it is below minScore', () => {
    const h = hit({ keywordScore: null, vectorScore: 0.3 })
    expect(filterRelevantHits([h], 0.4)).toEqual([])
  })

  it('keeps a mixed hit (both scores set, COALESCE case) on a strong keywordScore even with a weak vectorScore', () => {
    const h = hit({ keywordScore: 0.4, vectorScore: 0.05 })
    expect(filterRelevantHits([h], 0.4)).toEqual([h])
  })

  it('keeps a mixed hit on a strong vectorScore even with a keywordScore below the floor', () => {
    const h = hit({ keywordScore: 0.001, vectorScore: 0.9 })
    expect(filterRelevantHits([h], 0.4, 0.01)).toEqual([h])
  })

  it('drops a mixed hit when neither leg clears its threshold', () => {
    const h = hit({ keywordScore: 0.001, vectorScore: 0.1 })
    expect(filterRelevantHits([h], 0.4, 0.01)).toEqual([])
  })
})
