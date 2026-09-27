import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { parseArgs, parseToolArgs } from './shared'
import { executeRegisteredTool, type ToolExecutionContext } from '../tool-registry'

describe('parseArgs', () => {
  it('passes objects through and parses JSON strings', () => {
    expect(parseArgs({ a: 1 })).toEqual({ a: 1 })
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 })
  })

  it('returns {} for junk, arrays and non-object JSON', () => {
    expect(parseArgs('not json')).toEqual({})
    expect(parseArgs([1, 2])).toEqual({})
    expect(parseArgs('[1,2]')).toEqual({})
    expect(parseArgs('42')).toEqual({})
    expect(parseArgs(undefined)).toEqual({})
  })
})

describe('parseToolArgs', () => {
  const Schema = z.object({ task_id: z.string().nullish(), limit: z.number().nullish() })

  it('accepts omitted and null optional fields (models often send null)', () => {
    expect(parseToolArgs(Schema, {})).toEqual({})
    expect(parseToolArgs(Schema, { task_id: null, limit: null })).toEqual({ task_id: null, limit: null })
  })

  it('accepts JSON-string args', () => {
    expect(parseToolArgs(Schema, '{"task_id":"t1","limit":5}')).toEqual({ task_id: 't1', limit: 5 })
  })

  it('throws a readable error on a type mismatch', () => {
    expect(() => parseToolArgs(Schema, { limit: 'lots' })).toThrow(/invalid arguments — limit: Expected number/)
  })
})

describe('tool handlers validate args through their zod schema', () => {
  const ctx = {
    prisma: { task: { findUnique: vi.fn(), update: vi.fn() } },
  } as unknown as ToolExecutionContext

  it('keeps the handler’s own "required" message when the field is missing', async () => {
    expect(await executeRegisteredTool('orion_close_task', {}, ctx)).toBe('Error: task_id is required')
  })

  it('reports a type mismatch as an Error result without touching the DB', async () => {
    const out = await executeRegisteredTool('orion_get_task_events', { task_id: 't1', limit: 'ten' }, ctx)
    expect(out).toMatch(/^Error: invalid arguments — limit:/)
    expect((ctx.prisma as unknown as { task: { findUnique: ReturnType<typeof vi.fn> } }).task.findUnique).not.toHaveBeenCalled()
  })
})
