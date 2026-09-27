/**
 * syncGitOpsPRs — a tracked PR that no longer exists upstream (404) is closed
 * once instead of being retried and logged as an error every poll.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { prisma, provider, logs } = vi.hoisted(() => ({
  prisma: {
    environment: { findMany: vi.fn() },
    gitOpsPR: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
  provider: { isHealthy: vi.fn(), listOpenPRs: vi.fn(), getPR: vi.fn() },
  logs: { log: vi.fn(), err: vi.fn() },
}))

vi.mock('@/lib/db', () => ({ prisma }))
vi.mock('./log', () => logs)
vi.mock('@/lib/git-provider', async () => {
  const errors = await vi.importActual<typeof import('@/lib/git-provider/errors')>('@/lib/git-provider/errors')
  return { getGitProvider: vi.fn(async () => provider), isNotFound: errors.isNotFound }
})

import { syncGitOpsPRs } from './gitops-sync'
import { GitProviderHttpError } from '@/lib/git-provider/errors'

const trackedPR = (prNumber: number) => ({
  id: `pr-${prNumber}`, prNumber, environmentId: 'env-1', reasoning: null,
  environment: { gitOwner: 'gitea-admin', gitRepo: 'talos-cluster' },
})

beforeEach(() => {
  vi.clearAllMocks()
  provider.isHealthy.mockResolvedValue(true)
  prisma.environment.findMany.mockResolvedValue([])
})

describe('syncGitOpsPRs', () => {
  it('closes a tracked PR that 404s upstream, without logging an error', async () => {
    prisma.gitOpsPR.findMany.mockResolvedValue([trackedPR(115)])
    provider.getPR.mockRejectedValue(new GitProviderHttpError('Gitea GET /repos/x/y/pulls/115 → 404: not found', 404))

    await syncGitOpsPRs()

    expect(prisma.gitOpsPR.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'pr-115' },
      data: expect.objectContaining({ status: 'closed' }),
    }))
    expect(prisma.gitOpsPR.update.mock.calls[0][0].data.reasoning).toMatch(/no longer exists .*\(404\)/)
    expect(logs.err).not.toHaveBeenCalled()
  })

  it('keeps other provider failures as errors and leaves the PR open', async () => {
    prisma.gitOpsPR.findMany.mockResolvedValue([trackedPR(116)])
    provider.getPR.mockRejectedValue(new GitProviderHttpError('Gitea GET … → 502: bad gateway', 502))

    await syncGitOpsPRs()

    expect(prisma.gitOpsPR.update).not.toHaveBeenCalled()
    expect(logs.err).toHaveBeenCalledTimes(1)
  })

  it('still marks merged PRs as merged', async () => {
    prisma.gitOpsPR.findMany.mockResolvedValue([trackedPR(117)])
    provider.getPR.mockResolvedValue({ merged: true, state: 'closed', mergedAt: '2026-09-27T10:00:00Z' })

    await syncGitOpsPRs()

    expect(prisma.gitOpsPR.update).toHaveBeenCalledWith({
      where: { id: 'pr-117' },
      data: { status: 'merged', mergedAt: new Date('2026-09-27T10:00:00Z') },
    })
  })
})
