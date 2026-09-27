/**
 * Characterization test for the tool registry.
 *
 * Pins the externally visible shape of every registered tool — registration
 * order, name, tier, availableIn, category, parallelSafe, description and
 * inputSchema — so refactors of tool-registry.ts / lib/tools/* can prove they
 * changed nothing an LLM, the permission layer or a caller can observe.
 *
 * If this fails after an intentional tool change, review the diff and update
 * the snapshot with `npx vitest run -u src/lib/tool-registry.characterization.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { getAllTools, getToolsForContext, getAllCategories } from './tool-registry'
import './room-tools'

describe('tool registry characterization', () => {
  it('registers the same tools, in the same order, with the same metadata and schemas', () => {
    const shape = getAllTools().map(t => ({
      name: t.name,
      tier: t.tier,
      availableIn: t.availableIn,
      category: t.category ?? null,
      parallelSafe: t.parallelSafe,
      description: t.description,
      inputSchema: t.inputSchema,
      hasHandler: typeof t.handler === 'function',
    }))
    expect(shape).toMatchSnapshot()
  })

  it('exposes the same per-context tool lists', () => {
    expect({
      task: getToolsForContext('task').map(t => t.name),
      chat: getToolsForContext('chat').map(t => t.name),
      categories: getAllCategories(),
    }).toMatchSnapshot()
  })
})
