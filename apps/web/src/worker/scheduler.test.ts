import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { state } = vi.hoisted(() => ({ state: { stopping: false } }))

// Keep the job modules out of this unit test — only the table shape matters.
vi.mock('@/lib/job-runner', () => ({ recoverStalledJobs: vi.fn() }))
vi.mock('@/lib/security/crowdsec-bouncer', () => ({ syncCrowdSecDecisions: vi.fn() }))
vi.mock('@/workers/security-correlator', () => ({ runCorrelator: vi.fn() }))
vi.mock('@/jobs/security-poll-k8s', () => ({ runK8sPollerAll: vi.fn() }))
vi.mock('@/jobs/security-poll-elk', () => ({ runElkPollerAll: vi.fn() }))
vi.mock('@/jobs/security-poll-ntopng', () => ({ runNtopngPollerAll: vi.fn() }))
vi.mock('@/jobs/security-scan-vulns', () => ({ runEventTriggeredScan: vi.fn() }))
vi.mock('@/jobs/goal-heartbeat', () => ({ runGoalHeartbeat: vi.fn() }))
vi.mock('@/jobs/gitops-drift', () => ({ detectGitOpsDrift: vi.fn() }))
vi.mock('@/jobs/task-scheduler', () => ({ runScheduler: vi.fn() }))
vi.mock('./recovery', () => ({ recoverStuckTasks: vi.fn() }))
vi.mock('./poll', () => ({ pollOnce: vi.fn() }))
vi.mock('./watchers', () => ({ runWatchers: vi.fn() }))
vi.mock('./gitops-sync', () => ({ syncGitOpsPRs: vi.fn() }))
vi.mock('./approval-escalation', () => ({ escalateStalePendingValidation: vi.fn() }))
vi.mock('./federation-poller', () => ({ pollFederatedTasks: vi.fn() }))
vi.mock('./daily-scan', () => ({ runScheduledDailyScan: vi.fn() }))
vi.mock('./state', () => ({ isStopping: () => state.stopping, workerConfig: { pollIntervalMs: 15_000, maxConcurrent: 3 } }))

import { runJob, startScheduler, stopScheduler, workerJobs, type ScheduledJob } from './scheduler'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => { state.stopping = false })
afterEach(() => { stopScheduler(); vi.useRealTimers() })

describe('runJob', () => {
  it('skips a tick while the previous run is still in flight', async () => {
    const d = deferred()
    const fn = vi.fn(() => d.promise)
    const job: ScheduledJob = { name: 'slow', intervalMs: 1000, fn }
    runJob(job)
    runJob(job)
    expect(fn).toHaveBeenCalledTimes(1)
    d.resolve()
    await d.promise
    await new Promise(r => setTimeout(r, 0))
    runJob(job)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('allowOverlap jobs start even while a run is in flight', () => {
    const fn = vi.fn(() => new Promise<void>(() => {}))
    const job: ScheduledJob = { name: 'watchers', intervalMs: 1000, fn, allowOverlap: true }
    runJob(job)
    runJob(job)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('logs failures with the job name and releases the guard', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const fn = vi.fn(async () => { throw new Error('boom') })
    const job: ScheduledJob = { name: 'GitOps PR sync', intervalMs: 1000, fn }
    runJob(job)
    await new Promise(r => setTimeout(r, 0))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('GitOps PR sync failed: Error: boom'))
    runJob(job)
    expect(fn).toHaveBeenCalledTimes(2)
    write.mockRestore()
  })

  it('never starts once stopping', () => {
    state.stopping = true
    const fn = vi.fn(async () => {})
    runJob({ name: 'x', intervalMs: 1000, fn })
    runJob({ name: 'y', intervalMs: 1000, fn, allowOverlap: true })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('startScheduler / stopScheduler', () => {
  it('runs each job on its interval and stops cleanly', async () => {
    vi.useFakeTimers()
    const fn = vi.fn(async () => {})
    startScheduler([{ name: 'tick', intervalMs: 1000, fn }])
    await vi.advanceTimersByTimeAsync(3000)
    expect(fn).toHaveBeenCalledTimes(3)
    stopScheduler()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('workerJobs table', () => {
  it('has unique names and positive intervals', () => {
    const jobs = workerJobs()
    expect(new Set(jobs.map(j => j.name)).size).toBe(jobs.length)
    for (const j of jobs) expect(j.intervalMs).toBeGreaterThan(0)
  })

  it('uses the configured poll interval and lets watchers overlap (they guard per agent)', () => {
    const jobs = workerJobs()
    expect(jobs.find(j => j.name === 'Poll')?.intervalMs).toBe(15_000)
    expect(jobs.find(j => j.name === 'Watcher poll')?.allowOverlap).toBe(true)
    expect(jobs.filter(j => j.allowOverlap).map(j => j.name)).toEqual(['Watcher poll'])
  })
})
