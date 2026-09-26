import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db', () => ({
  prisma: {
    backgroundJob: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}))

import { prisma } from '@/lib/db'
import { startJobOnce, recoverStalledJobs, JOB_HEARTBEAT_STALE_MS, utcDateKey, periodKey } from './job-runner'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('startJobOnce', () => {
  it('creates the job with its dedupe key and runs it', async () => {
    vi.mocked(prisma.backgroundJob.create).mockResolvedValue({} as never)
    const fn = vi.fn().mockResolvedValue(undefined)
    const id = await startJobOnce('t', 'title', 't:2026-09-26', {}, fn)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(vi.mocked(prisma.backgroundJob.create).mock.calls[0][0].data).toMatchObject({
      type: 't', dedupeKey: 't:2026-09-26', status: 'queued',
    })
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('returns null without running when the period already has a job (unique violation)', async () => {
    vi.mocked(prisma.backgroundJob.create).mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
    const fn = vi.fn()
    expect(await startJobOnce('t', 'title', 't:2026-09-26', {}, fn)).toBeNull()
    await new Promise(r => setImmediate(r))
    expect(fn).not.toHaveBeenCalled()
  })

  it('propagates other errors', async () => {
    vi.mocked(prisma.backgroundJob.create).mockRejectedValue(new Error('db down'))
    await expect(startJobOnce('t', 'title', 'k', {}, vi.fn())).rejects.toThrow('db down')
  })
})

describe('job failure handling', () => {
  it('marks the job failed with the real job type in the log even if logging fails', async () => {
    vi.mocked(prisma.backgroundJob.create).mockResolvedValue({} as never)
    // appendLog-style writes fail; the final failure write must still land.
    vi.mocked(prisma.backgroundJob.update)
      .mockResolvedValueOnce({} as never) // status → running
      .mockRejectedValueOnce(new Error('log write failed')) // failure write w/ log line
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await startJobOnce('storage-bootstrap', 'x', 'k', {}, async () => { throw new Error('boom') })
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
    const failureWrite = vi.mocked(prisma.backgroundJob.update).mock.calls[1][0]
    expect(failureWrite.data).toMatchObject({ status: 'failed', logs: { push: 'storage-bootstrap failed: boom' } })
    // Fallback status-only write after the log write failed.
    expect(vi.mocked(prisma.backgroundJob.updateMany).mock.calls.some(
      ([arg]) => (arg as { data: { status?: string } }).data.status === 'failed',
    )).toBe(true)
    spy.mockRestore()
  })
})

describe('recoverStalledJobs', () => {
  it('only selects jobs whose heartbeat is stale (not every running job)', async () => {
    const before = Date.now()
    await recoverStalledJobs()
    const where = vi.mocked(prisma.backgroundJob.findMany).mock.calls[0][0]!.where as {
      OR: Array<{ heartbeatAt?: { lt: Date } | null }>
    }
    const cutoff = (where.OR[0].heartbeatAt as { lt: Date }).lt.getTime()
    expect(cutoff).toBeGreaterThanOrEqual(before - JOB_HEARTBEAT_STALE_MS - 50)
    expect(cutoff).toBeLessThanOrEqual(Date.now() - JOB_HEARTBEAT_STALE_MS + 50)
    expect(prisma.backgroundJob.updateMany).not.toHaveBeenCalled()
  })

  it('fails a stale job with a conditional update', async () => {
    vi.mocked(prisma.backgroundJob.findMany).mockResolvedValue([{ id: 'j1', ownerId: 'host:1' }] as never)
    await recoverStalledJobs()
    const arg = vi.mocked(prisma.backgroundJob.updateMany).mock.calls[0][0] as { where: { id: string }; data: { status: string } }
    expect(arg.where.id).toBe('j1')
    expect(arg.data.status).toBe('failed')
  })
})

describe('dedupe period keys', () => {
  it('produces stable keys per period', () => {
    expect(utcDateKey(new Date('2026-09-26T23:59:59Z'))).toBe('2026-09-26')
    const a = periodKey(5 * 60_000, new Date('2026-09-26T12:00:00Z'))
    const b = periodKey(5 * 60_000, new Date('2026-09-26T12:04:59Z'))
    const c = periodKey(5 * 60_000, new Date('2026-09-26T12:05:00Z'))
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
})
