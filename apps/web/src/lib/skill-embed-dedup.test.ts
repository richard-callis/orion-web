/**
 * Regression tests for the skill-matching embedding cost/dedup fix:
 *  1. matchAndInjectSkills must skip the (paid, up to 30s) generateEmbedding
 *     call entirely when the environment's installed skills have no stored
 *     embedding row (nebula_embeddings) — there's nothing for stage 2 to
 *     match against, so paying for the API call is pure waste.
 *  2. When callers share a SkillEmbedCache across multiple
 *     matchAndInjectSkills calls for the identical message text within one
 *     logical request/turn (e.g. room-agents.ts replying with several
 *     agents), generateEmbedding must fire at most once for that text —
 *     not once per caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Skill = { id: string; name: string; spec: string }

let skills: Skill[] = []
let embeddedSkillIds: Set<string> = new Set()
let vectorSearchResult: Array<{ nebulaId: string; score: number }> = []

const generateEmbeddingMock = vi.fn(async (_text: string) => ({ vector: [0.1, 0.2, 0.3], modelRef: 'test-model' }))

vi.mock('./db', () => ({
  prisma: {
    nebulaInstance: {
      findMany: vi.fn(() => Promise.resolve(skills)),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(skills.find(s => s.id === where.id) ?? null)),
    },
    nebulaEmbedding: {
      findFirst: vi.fn(({ where }: { where: { nebulaId: { in: string[] } } }) => {
        const hit = where.nebulaId.in.find(id => embeddedSkillIds.has(id))
        return Promise.resolve(hit ? { nebulaId: hit } : null)
      }),
    },
    skillExecutionLog: {
      create: vi.fn(() => Promise.resolve({})),
    },
    agentTrace: {
      create: vi.fn(() => Promise.resolve({})),
    },
  },
}))

vi.mock('./embeddings', () => ({
  generateEmbedding: (text: string) => generateEmbeddingMock(text),
  hybridSearch: vi.fn(),
  skillVectorSearch: vi.fn(() => Promise.resolve(vectorSearchResult)),
}))

vi.mock('./management-tools', () => ({ MANAGEMENT_TOOL_DEFS: [], executeManagedTool: vi.fn() }))
vi.mock('./tool-registry', () => ({ validateToolArgs: vi.fn() }))
vi.mock('./system-prompts', () => ({ getPrompt: vi.fn(), interpolate: vi.fn() }))

import { matchAndInjectSkills, type SkillEmbedCache } from './claude'

beforeEach(() => {
  skills = []
  embeddedSkillIds = new Set()
  vectorSearchResult = []
  generateEmbeddingMock.mockClear()
})

describe('matchAndInjectSkills — stage 2 pre-check', () => {
  it('never calls generateEmbedding when no installed skill has a stored embedding', async () => {
    skills = [{ id: 'skill-1', name: 'no-embedding-skill', spec: JSON.stringify({ triggerPatterns: ['zzz-no-match'], systemPrompt: 'x' }) }]
    // embeddedSkillIds intentionally left empty — skill-1 has no nebula_embeddings row

    const result = await matchAndInjectSkills('env-1', 'a message that matches nothing literally')

    expect(generateEmbeddingMock).not.toHaveBeenCalled()
    expect(result).toEqual({ injected: '', skillName: null })
  })

  it('does call generateEmbedding when at least one installed skill has a stored embedding', async () => {
    skills = [{ id: 'skill-1', name: 'embedded-skill', spec: JSON.stringify({ triggerPatterns: ['zzz-no-match'], systemPrompt: 'x' }) }]
    embeddedSkillIds = new Set(['skill-1'])
    vectorSearchResult = [] // no semantic hit, but the call must still happen

    await matchAndInjectSkills('env-1', 'some message')

    expect(generateEmbeddingMock).toHaveBeenCalledTimes(1)
  })
})

describe('matchAndInjectSkills — request-scoped embedding cache', () => {
  it('embeds identical message text only once across multiple calls sharing a cache', async () => {
    skills = [{ id: 'skill-1', name: 'embedded-skill', spec: JSON.stringify({ triggerPatterns: ['zzz-no-match'], systemPrompt: 'x' }) }]
    embeddedSkillIds = new Set(['skill-1'])
    vectorSearchResult = []

    const cache: SkillEmbedCache = new Map()
    const message = 'the exact same triggering message text'

    // Simulate 3 agents in the same room turn all matching against the same
    // latestTurn text, the way room-agents.ts's loop does when it passes a
    // shared cache into each matchAndInjectSkills call.
    await Promise.all([
      matchAndInjectSkills('env-1', message, 'room_match', 'room-1', cache),
      matchAndInjectSkills('env-1', message, 'room_match', 'room-1', cache),
      matchAndInjectSkills('env-1', message, 'room_match', 'room-1', cache),
    ])

    expect(generateEmbeddingMock).toHaveBeenCalledTimes(1)
  })

  it('embeds each distinct message text separately even with a shared cache', async () => {
    skills = [{ id: 'skill-1', name: 'embedded-skill', spec: JSON.stringify({ triggerPatterns: ['zzz-no-match'], systemPrompt: 'x' }) }]
    embeddedSkillIds = new Set(['skill-1'])
    vectorSearchResult = []

    const cache: SkillEmbedCache = new Map()

    await matchAndInjectSkills('env-1', 'message A', 'room_match', 'room-1', cache)
    await matchAndInjectSkills('env-1', 'message B', 'room_match', 'room-1', cache)

    expect(generateEmbeddingMock).toHaveBeenCalledTimes(2)
  })

  it('without a shared cache, each call embeds independently (no accidental cross-call caching)', async () => {
    skills = [{ id: 'skill-1', name: 'embedded-skill', spec: JSON.stringify({ triggerPatterns: ['zzz-no-match'], systemPrompt: 'x' }) }]
    embeddedSkillIds = new Set(['skill-1'])
    vectorSearchResult = []

    const message = 'same text, no cache passed'
    await matchAndInjectSkills('env-1', message, 'room_match', 'room-1')
    await matchAndInjectSkills('env-1', message, 'room_match', 'room-1')

    expect(generateEmbeddingMock).toHaveBeenCalledTimes(2)
  })
})
