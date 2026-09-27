/**
 * Regression test for the `knowledge_graph` tool's access-control gap
 * (follow-up to the hybridSearch/knowledge_search scoping fix): the handler
 * previously ran unscoped `prisma.note.findMany` / `prisma.semanticConnection
 * .findMany` queries, leaking every user's note titles/content (and, via
 * unscoped semantic edges, other users' note ids) to any authenticated
 * caller. It must now apply the same ownership scoping as `knowledge_search`
 * — see `ownerFilterWhere` in `lib/embeddings.ts` — restricting results to
 * the calling user's own notes plus unowned/shared (`createdBy: null`) notes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let noteFindManyWhere: unknown
let semanticConnectionWhere: unknown

const NOTES = [
  { id: 'n-mine', title: 'Mine', type: 'note', folder: 'General', content: 'my note' },
  { id: 'n-shared', title: 'Shared', type: 'note', folder: 'General', content: 'shared note' },
  { id: 'n-other', title: 'Other', type: 'note', folder: 'General', content: 'someone else\'s note' },
]

vi.mock('@/lib/db', () => ({
  prisma: {
    note: {
      findMany: vi.fn((args: { where?: unknown }) => {
        noteFindManyWhere = args?.where
        // Simulate the DB applying the where clause: emulate ownerFilterWhere's
        // { OR: [{ createdBy: null }, { createdBy }] } shape, or no filter.
        const where = args?.where as { OR?: Array<{ createdBy: string | null }> } | undefined
        if (!where || !where.OR) return Promise.resolve(NOTES)
        const allowed = new Set(where.OR.map(c => c.createdBy))
        const owned: Record<string, string | null> = {
          'n-mine': 'user-123',
          'n-shared': null,
          'n-other': 'user-456',
        }
        return Promise.resolve(NOTES.filter(n => allowed.has(owned[n.id])))
      }),
    },
    semanticConnection: {
      findMany: vi.fn((args: { where?: unknown }) => {
        semanticConnectionWhere = args?.where
        return Promise.resolve([])
      }),
    },
  },
}))

vi.mock('@/lib/default-model', () => ({ getDefaultModelId: vi.fn(() => Promise.resolve('default')) }))
vi.mock('@/lib/vault', () => ({ writeVaultSecret: vi.fn() }))
vi.mock('@/lib/ssrf-guard', () => ({ isPrivateUrl: vi.fn(() => Promise.resolve(false)) }))
vi.mock('@/lib/deployment-templates', () => ({ DEPLOYMENT_TEMPLATES: [], getTemplate: vi.fn() }))
vi.mock('@/lib/embeddings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/embeddings')>('@/lib/embeddings')
  return {
    ...actual,
    hybridSearch: vi.fn(() => Promise.resolve({ modelRef: null, hits: [] })),
  }
})

import { getToolDefinition, type ToolExecutionContext } from './tool-registry'
import { prisma } from '@/lib/db'

beforeEach(() => {
  noteFindManyWhere = undefined
  semanticConnectionWhere = undefined
  vi.clearAllMocks()
})

function ctx(userId?: string): ToolExecutionContext {
  return { userId, prisma }
}

describe('knowledge_graph tool — per-caller note scoping', () => {
  it('runs unscoped (no where filter) for a trusted/unscoped caller (no ctx.userId)', async () => {
    const tool = getToolDefinition('knowledge_graph')
    expect(tool).toBeDefined()

    const result = await tool!.handler({}, ctx(undefined))

    expect(noteFindManyWhere).toEqual({})
    expect(result).toContain('Mine')
    expect(result).toContain('Shared')
    expect(result).toContain('Other')
  })

  it('scopes results to the caller\'s own notes plus shared notes when ctx.userId is set', async () => {
    const tool = getToolDefinition('knowledge_graph')

    const result = await tool!.handler({}, ctx('user-123'))

    expect(noteFindManyWhere).toEqual({ OR: [{ createdBy: null }, { createdBy: 'user-123' }] })
    expect(result).toContain('Mine')
    expect(result).toContain('Shared')
    expect(result).not.toContain('Other')
  })

  it('scopes the semantic-edge query to only the notes the caller can see', async () => {
    const tool = getToolDefinition('knowledge_graph')

    await tool!.handler({}, ctx('user-123'))

    expect(semanticConnectionWhere).toMatchObject({
      sourceNoteId: { in: ['n-mine', 'n-shared'] },
      targetNoteId: { in: ['n-mine', 'n-shared'] },
    })
  })
})
