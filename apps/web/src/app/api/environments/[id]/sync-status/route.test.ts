import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { prisma } = vi.hoisted(() => ({
  prisma: {
    environment: { findUnique: vi.fn(), update: vi.fn() },
    gitOpsPR: { findMany: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/db', () => ({ prisma }))
vi.mock('@/lib/auth', () => ({ requireGatewayAuthForEnvironment: vi.fn(async () => {}) }))

import { POST } from './route'

const post = (body: unknown) => POST(
  new NextRequest('http://x/api/environments/e1/sync-status', { method: 'POST', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: 'e1' }) },
)
const applications = [{ name: 'a', namespace: 'argocd', project: 'p', syncStatus: 'Synced', healthStatus: 'Healthy', revision: 'r1', message: '', reconciledAt: null }]

beforeEach(() => {
  prisma.environment.findUnique.mockReset().mockResolvedValue({ id: 'e1', metadata: {} })
  prisma.environment.update.mockReset().mockResolvedValue({})
  prisma.gitOpsPR.findMany.mockReset().mockResolvedValue([{ id: 'pr1' }])
  prisma.gitOpsPR.update.mockReset().mockResolvedValue({})
})

describe('POST /api/environments/:id/sync-status', () => {
  it('closes open auto PRs on a reported change', async () => {
    expect((await post({ applications })).status).toBe(200)
    expect(prisma.gitOpsPR.update).toHaveBeenCalledTimes(1)
  })

  it('a refresh renews the stored state but never touches a PR', async () => {
    expect((await post({ applications, refresh: true })).status).toBe(200)
    const meta = prisma.environment.update.mock.calls[0][0].data.metadata
    expect(Date.now() - new Date(meta.argocd.reportedAt).getTime()).toBeLessThan(60_000)
    expect(prisma.gitOpsPR.findMany).not.toHaveBeenCalled()
    expect(prisma.gitOpsPR.update).not.toHaveBeenCalled()
  })
})
