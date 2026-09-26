/**
 * Security source staleness check — periodic cron job.
 *
 * Scans SourceHealth and EnvironmentSourceHealth for sources whose
 * lastSeenAt is older than their staleAfterMs threshold and emits a
 * `source_stale` SecurityEvent ("source has gone dark") so the SOC is
 * alerted when a feed stops delivering data.
 *
 * Dedup: there is NO unique constraint on SecurityEvent.dedupKey, so we
 * bucket the dedupKey by hour and do a check-then-insert findFirst guard.
 * This is not atomic — two concurrent runs could both pass the guard — but
 * concurrent runs are rare and a duplicate "gone dark" event is harmless,
 * so this trade-off is acceptable (documented per handoff rules).
 *
 * Modeled after security-retention-daily.ts (node-cron) — runs every 5min.
 */

import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { prisma } from '@/lib/db'
import { startJob, startJobOnce, periodKey } from '@/lib/job-runner'
import type { JobLogger } from '@/lib/job-runner'

const STALE_CHECK_PERIOD_MS = 5 * 60_000

function startStaleCheck(title: string): void {
  startJobOnce(
    'security-stale-check',
    title,
    `security-stale-check:${periodKey(STALE_CHECK_PERIOD_MS)}`,
    {},
    runSecurityStaleCheckJob,
  ).catch((err) => console.error('[security-stale-check] run failed to start:', err))
}

let _task: ScheduledTask | null = null

/**
 * Schedule the staleness check with node-cron (every 5 minutes) and fire
 * once on startup. Called only from the worker process. Each 5-minute period
 * gets one job at most (dedupe key), so the catch-up, the cron tick and any
 * overlapping worker never double-run it.
 *
 * Cron: "*\/5 * * * *" — every 5 minutes.
 */
export function ensureSecurityStaleCheckJobScheduled(): ScheduledTask {
  if (_task) return _task
  _task = cron.schedule('*/5 * * * *', () => {
    startStaleCheck('Security staleness check: detect sources that have gone dark')
  })
  startStaleCheck('Security staleness check: startup catch-up')
  return _task
}

/**
 * Run the staleness check. Called by startJob with a log function.
 */
export async function runSecurityStaleCheckJob(log: JobLogger): Promise<void> {
  await log('Starting security staleness check')

  const now = Date.now()
  const hourBucket = new Date().toISOString().slice(0, 13)

  // Fetch all health rows; compute staleness in JS (staleAfterMs is per-row).
  const [globalRows, envRows] = await Promise.all([
    prisma.sourceHealth.findMany({
      select: { source: true, lastSeenAt: true, staleAfterMs: true },
    }),
    prisma.environmentSourceHealth.findMany({
      select: { source: true, lastSeenAt: true, staleAfterMs: true, environmentId: true },
    }),
  ])

  const isStale = (lastSeenAt: Date | null, staleAfterMs: number): boolean => {
    const ts = lastSeenAt ? new Date(lastSeenAt).getTime() : 0
    return now - ts > staleAfterMs
  }

  const staleGlobal = globalRows.filter(r => isStale(r.lastSeenAt, r.staleAfterMs))
  const staleEnv = envRows.filter(r => isStale(r.lastSeenAt, r.staleAfterMs))

  let created = 0

  for (const s of staleGlobal) {
    const dedupKey = `source_stale:${s.source}:${hourBucket}`
    // Check-then-insert (not atomic, but concurrent runs are harmless duplicates — acceptable)
    const exists = await prisma.securityEvent.findFirst({ where: { dedupKey } })
    if (exists) continue
    await prisma.securityEvent.create({
      data: {
        type: 'source_stale',
        source: s.source,
        severity: 40,
        title: `Source ${s.source} has gone dark`,
        description: `No events received recently`,
        dedupKey,
        rawEvent: { source: s.source },
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    })
    created++
  }

  for (const s of staleEnv) {
    const dedupKey = `source_stale:${s.source}:${s.environmentId}:${hourBucket}`
    const exists = await prisma.securityEvent.findFirst({ where: { dedupKey } })
    if (exists) continue
    await prisma.securityEvent.create({
      data: {
        type: 'source_stale',
        source: s.source,
        environmentId: s.environmentId,
        severity: 40,
        title: `Source ${s.source} has gone dark`,
        description: `No events received recently`,
        dedupKey,
        rawEvent: { source: s.source, environmentId: s.environmentId },
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    })
    created++
  }

  await log(
    `Staleness check complete: ${staleGlobal.length + staleEnv.length} stale source(s), ${created} new event(s) emitted`,
  )
}

/**
 * Manually trigger the staleness check (admin only).
 */
export async function runSecurityStaleCheckManual(): Promise<string> {
  return startJob(
    'security-stale-check',
    'Manual security staleness check',
    {},
    runSecurityStaleCheckJob,
  )
}
