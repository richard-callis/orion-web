/**
 * POST /api/environments/:id/gateway — cluster gateways are read-only and
 * refuse self-update; docker/localhost gateways are told to restart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { environment, fetchMock } = vi.hoisted(() => ({
  environment: { findUnique: vi.fn() },
  fetchMock: vi.fn(),
}))
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn(async () => ({ id: 'admin-1' })) }))
vi.mock('@/lib/db', () => ({ prisma: { environment } }))
vi.stubGlobal('fetch', fetchMock)

import { POST } from './route'

const call = () => POST(new NextRequest('http://x', { method: 'POST' }), { params: Promise.resolve({ id: 'env-1' }) })

beforeEach(() => { environment.findUnique.mockReset(); fetchMock.mockReset() })

describe('gateway update route', () => {
  it('refuses cluster gateways with a GitOps instruction and never calls the gateway', async () => {
    environment.findUnique.mockResolvedValue({ id: 'env-1', type: 'cluster', gatewayUrl: 'http://gw', gatewayToken: 't' })
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/GitOps/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tells a docker gateway to restart', async () => {
    environment.findUnique.mockResolvedValue({ id: 'env-1', type: 'docker', gatewayUrl: 'http://gw', gatewayToken: 't' })
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const res = await call()
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith('http://gw/update', expect.objectContaining({ method: 'POST' }))
  })
})
