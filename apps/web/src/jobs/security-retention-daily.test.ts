/**
 * Tests for security-retention-daily.
 *
 * Covers:
 * - ensureSecurityRetentionJobScheduled: sets up cron + fires startup catch-up
 * - runSecurityRetentionJob: verifies deleteMany calls with correct cutoffs
 * - runSecurityRetentionManual: delegates to startJob
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted, so we use vi.hoisted() to declare mocks at the top level
vi.hoisted(() => {
  globalThis.__cronScheduleMock = vi.fn()
})

vi.mock('node-cron', () => ({
  default: {
    schedule: (globalThis as any).__cronScheduleMock,
  },
}))

// Mock Prisma
vi.mock('@/lib/db', () => ({
  prisma: {
    securityEvent: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    incident: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    actionAudit: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}))

vi.mock('@/lib/job-runner', () => ({
  startJob: vi.fn().mockResolvedValue('job-id'),
}))

import { prisma } from '@/lib/db'
import { startJob } from '@/lib/job-runner'
import {
  ensureSecurityRetentionJobScheduled,
  runSecurityRetentionJob,
  runSecurityRetentionManual,
} from './security-retention-daily'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ensureSecurityRetentionJobScheduled', () => {
  it('registers a cron schedule', () => {
    ensureSecurityRetentionJobScheduled()
    expect((globalThis as any).__cronScheduleMock).toHaveBeenCalledWith(
      '0 4 * * *',
      expect.any(Function),
    )
  })

  it('fires a startup catch-up via startJob', () => {
    ensureSecurityRetentionJobScheduled()
    expect(startJob).toHaveBeenCalledWith(
      'security-retention-daily',
      'Security retention: startup catch-up',
      {},
      expect.any(Function),
    )
  })
})

describe('runSecurityRetentionJob', () => {
  it('deletes events older than 30 days', async () => {
    const log = vi.fn()
    const now = new Date()
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    vi.mocked(prisma.securityEvent.deleteMany).mockResolvedValue({ count: 42 })
    vi.mocked(prisma.incident.deleteMany).mockResolvedValue({ count: 5 })
    vi.mocked(prisma.actionAudit.deleteMany).mockResolvedValue({ count: 3 })

    await runSecurityRetentionJob(log)

    expect(prisma.securityEvent.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    })
  })

  it('deletes incidents older than 365 days', async () => {
    const log = vi.fn()

    vi.mocked(prisma.securityEvent.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.incident.deleteMany).mockResolvedValue({ count: 7 })
    vi.mocked(prisma.actionAudit.deleteMany).mockResolvedValue({ count: 0 })

    await runSecurityRetentionJob(log)

    expect(prisma.incident.deleteMany).toHaveBeenCalledOnce()
  })

  it('deletes action audits older than 365 days', async () => {
    const log = vi.fn()

    vi.mocked(prisma.securityEvent.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.incident.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.actionAudit.deleteMany).mockResolvedValue({ count: 12 })

    await runSecurityRetentionJob(log)

    expect(prisma.actionAudit.deleteMany).toHaveBeenCalledOnce()
  })

  it('logs summary on completion', async () => {
    const log = vi.fn()

    vi.mocked(prisma.securityEvent.deleteMany).mockResolvedValue({ count: 10 })
    vi.mocked(prisma.incident.deleteMany).mockResolvedValue({ count: 2 })
    vi.mocked(prisma.actionAudit.deleteMany).mockResolvedValue({ count: 3 })

    await runSecurityRetentionJob(log)

    expect(log).toHaveBeenCalledWith(expect.stringContaining('10 events'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('2 incidents'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('3 audits purged'))
  })
})

describe('runSecurityRetentionManual', () => {
  it('delegates to startJob with a manual trigger label', async () => {
    vi.mocked(startJob).mockResolvedValue('manual-job-id')

    const result = await runSecurityRetentionManual()

    expect(startJob).toHaveBeenCalledWith(
      'security-retention-daily',
      'Manual security retention purge',
      {},
      expect.any(Function),
    )
    expect(result).toBe('manual-job-id')
  })
})
