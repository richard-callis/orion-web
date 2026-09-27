/**
 * Periodic worker jobs, declared as a table and run with a shared in-flight
 * guard: a job whose previous run is still going is skipped, so a slow run
 * never stacks on itself (e.g. a 15s ELK poll that takes >15s would otherwise
 * produce competing cursor updates). Nothing starts once shutdown begins.
 */
import { recoverStalledJobs } from '@/lib/job-runner'
import { syncCrowdSecDecisions } from '@/lib/security/crowdsec-bouncer'
import { runCorrelator } from '@/workers/security-correlator'
import { runK8sPollerAll } from '@/jobs/security-poll-k8s'
import { runElkPollerAll } from '@/jobs/security-poll-elk'
import { runNtopngPollerAll } from '@/jobs/security-poll-ntopng'
import { runEventTriggeredScan } from '@/jobs/security-scan-vulns'
import { runGoalHeartbeat } from '@/jobs/goal-heartbeat'
import { detectGitOpsDrift } from '@/jobs/gitops-drift'
import { runScheduler } from '@/jobs/task-scheduler'
import { err } from './log'
import { isStopping, workerConfig } from './state'
import { recoverStuckTasks } from './recovery'
import { pollOnce } from './poll'
import { runWatchers } from './watchers'
import { syncGitOpsPRs } from './gitops-sync'
import { escalateStalePendingValidation } from './approval-escalation'
import { pollFederatedTasks } from './federation-poller'
import { runScheduledDailyScan } from './daily-scan'

export interface ScheduledJob {
  /** Label used in error logs: "<name> failed: <error>". */
  name: string
  intervalMs: number
  fn: () => Promise<unknown>
  /**
   * Let a new run start while the previous one is still in flight. Only for
   * jobs with their own finer-grained guard (watchers are guarded per agent,
   * so one slow watcher must not hold back every other due watcher).
   */
  allowOverlap?: boolean
}

const MINUTE = 60_000

/** The worker's periodic jobs. Built at start so it sees the loaded workerConfig. */
export function workerJobs(): ScheduledJob[] {
  return [
    // Re-queue claimed tasks whose worker stopped heartbeating (crash, SIGKILL).
    // Heartbeats come from runTask, so a long but healthy run is never recovered
    // out from under itself. Startup runs the initial pass.
    { name: 'Periodic recovery',            intervalMs: 5 * MINUTE, fn: recoverStuckTasks },
    // Background jobs orphaned by a dead process (stale heartbeat) → failed.
    { name: 'Background job recovery',      intervalMs: 5 * MINUTE, fn: recoverStalledJobs },
    // Ongoing poll for assigned tasks (pollOnce also has its own in-flight guard).
    { name: 'Poll',                         intervalMs: workerConfig.pollIntervalMs, fn: pollOnce },
    // Check every minute whether any watcher is due.
    { name: 'Watcher poll',                 intervalMs: MINUTE, fn: runWatchers, allowOverlap: true },
    // Poll the git provider every 60s to catch merges missed by webhooks.
    { name: 'GitOps PR sync',               intervalMs: MINUTE, fn: syncGitOpsPRs },
    // Security correlator — uncorrelated events.
    { name: 'Security correlator',          intervalMs: 30_000, fn: runCorrelator },
    { name: 'K8s poller',                   intervalMs: 30_000, fn: runK8sPollerAll },
    // No-ops if ELK_URL / NTOPNG_URL are not set.
    { name: 'ELK poller',                   intervalMs: 15_000, fn: runElkPollerAll },
    { name: 'ntopng poller',                intervalMs: 30_000, fn: runNtopngPollerAll },
    // Application-layer CrowdSec blocklist. Independent of the pollers so a slow
    // LAPI doesn't block event ingestion; has its own internal debounce.
    { name: 'CrowdSec sync',                intervalMs: 30_000, fn: syncCrowdSecDecisions },
    { name: 'Event-triggered vuln scan',    intervalMs: MINUTE, fn: runEventTriggeredScan },
    // Daily scheduled scan at 02:00 server time, as an hourly tick (see daily-scan.ts).
    {
      name: 'Daily vuln scan tick',
      intervalMs: 60 * MINUTE,
      fn: async () => { if (new Date().getHours() === 2) await runScheduledDailyScan() },
    },
    // Re-trigger agents in rooms whose active goal has gone stale (see jobs/goal-heartbeat.ts).
    { name: 'Goal heartbeat',               intervalMs: 5 * MINUTE, fn: runGoalHeartbeat },
    // Cron scheduler — scheduled tasks due to run.
    { name: 'Task scheduler',               intervalMs: MINUTE, fn: runScheduler },
    // Escalate tasks waiting for plan approval longer than APPROVAL_TIMEOUT_MS.
    { name: 'Approval timeout escalation',  intervalMs: 5 * MINUTE, fn: escalateStalePendingValidation },
    // Compare live cluster state to desired GitOps state.
    { name: 'GitOps drift detection',       intervalMs: 5 * MINUTE, fn: detectGitOpsDrift },
    // Check in-flight federated tasks for completion.
    { name: 'Federation spoke polling',     intervalMs: MINUTE, fn: pollFederatedTasks },
  ]
}

const intervalHandles: ReturnType<typeof setInterval>[] = []
const inFlight = new Set<string>()

/** Run one tick of `job` unless shutting down or (unless allowed) still running. */
export function runJob(job: ScheduledJob): void {
  if (isStopping()) return
  if (job.allowOverlap) {
    job.fn().catch(e => err(`${job.name} failed: ${e}`))
    return
  }
  if (inFlight.has(job.name)) return
  inFlight.add(job.name)
  job.fn()
    .catch(e => err(`${job.name} failed: ${e}`))
    .finally(() => { inFlight.delete(job.name) })
}

/** Start every job on its interval (first run after one interval). */
export function startScheduler(jobs: ScheduledJob[] = workerJobs()): void {
  for (const job of jobs) {
    intervalHandles.push(setInterval(() => runJob(job), job.intervalMs))
  }
}

/** Clear every interval the scheduler owns. Call after markStopping(). */
export function stopScheduler(): void {
  for (const handle of intervalHandles) clearInterval(handle)
  intervalHandles.length = 0
}
