/**
 * Tests for security-retention-daily.
 *
 * Covers:
 * - ensureSecurityRetentionJobScheduled: sets up cron + fires a deduplicated startup catch-up
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
    vulnerabilityFinding: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  },
}))

vi.mock('@/lib/job-runner', () => ({
  startJob: vi.fn().mockResolvedValue('job-id'),
  startJobOnce: vi.fn().mockResolvedValue('job-id'),
  utcDateKey: () => '2026-09-26',
}))

import { prisma } from '@/lib/db'
import { startJob, startJobOnce } from '@/lib/job-runner'
import {
  ensureSecurityRetentionJobScheduled,
  runSecurityRetentionJob,
  runSecurityRetentionManual,
  purgeOperationalData,
} from './security-retention-daily'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ensureSecurityRetentionJobScheduled', () => {
  it('registers a daily cron and a startup catch-up deduplicated per UTC day, once', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
    const task = { stop: vi.fn() }
    ;(globalThis as any).__cronScheduleMock.mockReturnValue(task)

    expect(ensureSecurityRetentionJobScheduled()).toBe(task)
    expect((globalThis as any).__cronScheduleMock).toHaveBeenCalledWith(
      '0 4 * * *',
      expect.any(Function),
    )
    expect(startJobOnce).toHaveBeenCalledWith(
      'security-retention-daily',
      'Security retention: startup catch-up',
      'security-retention-daily:2026-09-26',
      {},
      expect.any(Function),
    )

    // The cron tick uses the same per-day key, so it can't double-run the job.
    const tick = (globalThis as any).__cronScheduleMock.mock.calls[0][1] as () => void
    tick()
    expect(vi.mocked(startJobOnce).mock.calls[1][2]).toBe('security-retention-daily:2026-09-26')

    // Registration itself is idempotent within a process.
    expect(ensureSecurityRetentionJobScheduled()).toBe(task)
    expect((globalThis as any).__cronScheduleMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
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

    const where = vi.mocked(prisma.securityEvent.deleteMany).mock.calls[0][0]!.where as any
    // Cutoff is computed inside the job, a few ms after ours
    expect(Math.abs(where.createdAt.lt.getTime() - cutoff.getTime())).toBeLessThan(5_000)
    // Events linked to non-closed incidents are kept as evidence
    expect(where.OR).toEqual([
      { incidentId: null },
      { incident: { status: { in: ['closed'] } } },
    ])
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

describe('purgeOperationalData', () => {
  const sqlCalls = () => vi.mocked(prisma.$executeRawUnsafe).mock.calls.map(c => String(c[0]))

  it('clears AgentTrace.fullContext and purges every operational table in batches', async () => {
    const log = vi.fn()
    await purgeOperationalData(log)

    const sql = sqlCalls()
    expect(sql[0]).toMatch(/UPDATE "AgentTrace" SET "fullContext" = NULL/)
    for (const table of [
      'AgentTrace', 'ToolExecution', 'HookExecutionLog', 'SkillExecutionLog', 'JobRun',
      'WebhookDelivery', 'AgentMessage', 'ClaudeInvocation', 'TaskEvent',
      'InvestigationTimeline', 'AgentTokenUsage',
    ]) {
      expect(sql.some(q => q.startsWith(`DELETE FROM "${table}"`))).toBe(true)
    }
    expect(sql.every(q => /LIMIT 5000/.test(q))).toBe(true)
  })

  it('never purges user chat history or live approvals', async () => {
    await purgeOperationalData(vi.fn())
    const sql = sqlCalls()
    expect(sql.some(q => q.includes('DELETE FROM "Message"'))).toBe(false)
    const toolExec = sql.find(q => q.startsWith('DELETE FROM "ToolExecution"'))!
    expect(toolExec).toContain(`NOT IN ('pending', 'running')`)
  })

  it('keeps deleting while full batches come back', async () => {
    vi.mocked(prisma.$executeRawUnsafe)
      .mockResolvedValueOnce(0)     // fullContext clear
      .mockResolvedValueOnce(5000)  // AgentTrace batch 1 (full)
      .mockResolvedValueOnce(12)    // AgentTrace batch 2 (partial -> stop)
    const log = vi.fn()
    await purgeOperationalData(log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('AgentTrace purged: 5012 rows'))
  })

  it('honours retention.<Model>.days overrides, with 0 disabling the table', async () => {
    vi.mocked(prisma.systemSetting.findUnique).mockImplementation((async (args: any) =>
      args.where.key === 'retention.TaskEvent.days' ? { key: args.where.key, value: 0 } : null) as any)
    const log = vi.fn()
    await purgeOperationalData(log)
    expect(sqlCalls().some(q => q.startsWith('DELETE FROM "TaskEvent"'))).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('TaskEvent: retention disabled'))
    vi.mocked(prisma.systemSetting.findUnique).mockResolvedValue(null)
  })

  it('does not fail the security purge when operational retention errors', async () => {
    vi.mocked(prisma.$executeRawUnsafe).mockRejectedValueOnce(new Error('db down'))
    const log = vi.fn()
    await runSecurityRetentionJob(log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Operational retention failed: db down'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Security retention complete'))
  })
})
