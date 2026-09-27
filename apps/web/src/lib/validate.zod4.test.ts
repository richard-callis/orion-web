/**
 * zod 4 migration guards: the client-facing error shape from parseBodyOrError,
 * custom `message` params, and the two-argument z.record schemas.
 */
import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { parseBodyOrError, CreateConversationSchema, CreateEnvironmentSchema, CreateSSOSchema } from './validate'

const req = (body: unknown) =>
  new NextRequest('http://x', { method: 'POST', body: JSON.stringify(body) })

describe('parseBodyOrError (zod 4)', () => {
  it('keeps the { error, issues: [{ path, message }] } response shape', async () => {
    const r = await parseBodyOrError(req({ name: 'Bad Name!', type: 'cluster', gatewayUrl: 'not a url' }), CreateEnvironmentSchema)
    expect('error' in r).toBe(true)
    if (!('error' in r)) return
    expect(r.error.status).toBe(400)
    const body = await r.error.json()
    expect(body.error).toBe('Invalid request body')
    expect(Array.isArray(body.issues)).toBe(true)
    for (const i of body.issues) {
      expect(Object.keys(i).sort()).toEqual(['message', 'path'])
      expect(typeof i.path).toBe('string')
      expect(typeof i.message).toBe('string')
    }
    // custom `message` params still surface verbatim
    const byPath = Object.fromEntries(body.issues.map((i: { path: string; message: string }) => [i.path, i.message]))
    expect(byPath.name).toBe('name must be a valid DNS label (lowercase alphanumeric, hyphens, 1-100 chars)')
    expect(byPath.gatewayUrl).toBe('gatewayUrl must be a valid URL')
  })

  it('returns data on success, applying defaults', async () => {
    const r = await parseBodyOrError(req({ name: 'prod-1', gatewayUrl: null }), CreateEnvironmentSchema)
    expect('data' in r && r.data.type).toBe('cluster')
  })
})

describe('z.record(z.string(), …) schemas', () => {
  it('accept string-keyed objects', () => {
    expect(CreateConversationSchema.safeParse({ metadata: { a: 1, b: { c: true } } }).success).toBe(true)
  })

  it('reject non-objects', () => {
    expect(CreateConversationSchema.safeParse({ metadata: 'nope' }).success).toBe(false)
  })

  it('validate record values and refinements (SSO group mapping)', () => {
    expect(CreateSSOSchema.safeParse({ groupMapping: { admins: 'admin' } }).success).toBe(true)
    expect(CreateSSOSchema.safeParse({ groupMapping: { admins: 'x'.repeat(201) } }).success).toBe(false)
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`g${i}`, 'user']))
    const r = CreateSSOSchema.safeParse({ groupMapping: tooMany })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].message).toBe('Maximum 20 group mappings allowed')
  })
})
