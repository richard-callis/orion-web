/**
 * makeCrudRoutes POST — write access for session callers (SOC2 M5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { z } from 'zod'

const { note, auth } = vi.hoisted(() => ({
  note: { create: vi.fn() },
  auth: { current: null as null | { id: string; role: string }, service: false },
}))

vi.mock('@/lib/db', () => ({ prisma: { note } }))
vi.mock('@/lib/auth', () => ({
  requireServiceAuth: vi.fn(async () => {
    if (auth.service) return null
    if (!auth.current) throw new Error('Unauthorized')
    return auth.current
  }),
}))

import { makeCrudRoutes } from './crud-route-factory'

const { POST } = makeCrudRoutes({ model: 'note', createSchema: z.object({ title: z.string() }) })
const req = () => new NextRequest('http://x/api/notes', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'hello' }),
})

beforeEach(() => {
  auth.current = null
  auth.service = false
  note.create.mockReset().mockResolvedValue({ id: 'n1', title: 'hello' })
})

describe('makeCrudRoutes POST', () => {
  it('returns 401 (not 500) when unauthenticated', async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it('rejects readonly session users', async () => {
    auth.current = { id: 'u1', role: 'readonly' }
    expect((await POST(req())).status).toBe(403)
    expect(note.create).not.toHaveBeenCalled()
  })

  it('allows users with write access', async () => {
    auth.current = { id: 'u1', role: 'user' }
    expect((await POST(req())).status).toBe(201)
  })

  it('allows service (gateway) callers', async () => {
    auth.service = true
    expect((await POST(req())).status).toBe(201)
  })
})
