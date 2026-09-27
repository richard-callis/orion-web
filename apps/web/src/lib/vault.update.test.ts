/**
 * updateVaultSecret — merge semantics: rotating one key must never wipe the others.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./db', () => ({
  prisma: { systemSetting: { findUnique: vi.fn(async () => ({ value: 'enc:token' })) } },
}))
vi.mock('./encryption', () => ({ PREFIX: 'enc:', decrypt: () => 'vault-token' }))

import { updateVaultSecret } from './vault'

type Call = { url: string; method: string; body?: { options?: { cas?: number }; data?: Record<string, string> } }
let calls: Call[]
let responses: Array<() => Response>

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const current = (data: Record<string, string>, version: number) =>
  () => json(200, { data: { data, metadata: { version } } })

beforeEach(() => {
  calls = []
  responses = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected fetch ${url}`)
    return next()
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('updateVaultSecret', () => {
  it('overwrites only the given key and keeps the rest', async () => {
    responses.push(current({ user: 'app', password: 'old', host: 'db' }, 3), () => json(200, {}))
    const keys = await updateVaultSecret('secret/data/myapp/db', { password: 'new' })
    const write = calls[1]
    expect(write.method).toBe('POST')
    expect(write.url).toMatch(/\/v1\/secret\/data\/myapp\/db$/)
    expect(write.body).toEqual({ options: { cas: 3 }, data: { user: 'app', password: 'new', host: 'db' } })
    expect(keys.sort()).toEqual(['host', 'password', 'user'])
  })

  it('deletes only keys listed in remove', async () => {
    responses.push(current({ a: '1', b: '2' }, 1), () => json(200, {}))
    await updateVaultSecret('x', {}, ['b'])
    expect(calls[1].body?.data).toEqual({ a: '1' })
  })

  it('treats a missing secret as empty and writes with cas=0', async () => {
    responses.push(() => json(404, { errors: [] }), () => json(200, {}))
    await updateVaultSecret('new/path', { k: 'v' })
    expect(calls[1].body).toEqual({ options: { cas: 0 }, data: { k: 'v' } })
  })

  it('onlyMissing never overwrites existing values (placeholders)', async () => {
    responses.push(current({ password: 'real' }, 2), () => json(200, {}))
    await updateVaultSecret('p', { password: 'PLACEHOLDER', user: 'PLACEHOLDER' }, [], { onlyMissing: true })
    expect(calls[1].body?.data).toEqual({ password: 'real', user: 'PLACEHOLDER' })
  })

  it('retries on a check-and-set conflict using the fresh version', async () => {
    responses.push(
      current({ a: '1' }, 1),
      () => json(400, { errors: ['check-and-set parameter did not match the current version'] }),
      current({ a: '1', b: 'concurrent' }, 2),
      () => json(200, {}),
    )
    await updateVaultSecret('p', { a: '9' })
    expect(calls[3].body).toEqual({ options: { cas: 2 }, data: { a: '9', b: 'concurrent' } })
  })

  it('surfaces read errors instead of writing', async () => {
    responses.push(() => json(403, { errors: ['permission denied'] }))
    await expect(updateVaultSecret('p', { a: '1' })).rejects.toThrow(/permission denied/)
    expect(calls).toHaveLength(1)
  })
})
