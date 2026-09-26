/**
 * Security event retention — daily TTL job.
 *
 * Cleans up old security data according to retention policy:
 * - SecurityEvent: 30 days
 * - Incident: 365 days
 * - ActionAudit: 365 days
 *
 * Hook: on success, triggers S3 audit-export via existing path.
 *
 * Modeled after audit-export-daily.ts pattern.
 *
 * Deviations:
 * - Uses node-cron for daily scheduling (chosen as smallest dep;
 *   0 4 * * * = 4 AM daily). Documented here per handoff rule 4.
 */

import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { prisma } from '@/lib/db'
import { startJob, startJobOnce, utcDateKey } from '@/lib/job-runner'
import type { JobLogger } from '@/lib/job-runner'

// ── Configuration ─────────────────────────────────────────────────────────────

const SECURITY_EVENT_RETENTION_DAYS = 30
const INCIDENT_RETENTION_DAYS = 365
const ACTION_AUDIT_RETENTION_DAYS = 365

// ── Daily job entry point ─────────────────────────────────────────────────────

/**
 * Schedule the retention job with node-cron (daily at 4 AM) and fire once
 * on startup to cover any gap since last shutdown. Called only from the worker
 * process (jobs/scheduled-jobs.ts), never from the web server, so it is
 * registered once per deployment rather than once per web replica.
 *
 * Idempotent per UTC day: every run goes through startJobOnce() with the key
 * "security-retention-daily:<date>", so the startup catch-up, the cron tick and
 * any overlapping worker (e.g. during a deploy) create at most one job per day.
 *
 * Cron: "0 4 * * *" — daily at 4:00 AM.
 * node-cron chosen because:
 *   - Smallest cron dependency (no BullMQ/pg_cron required)
 *   - Existing codebase already uses interval-based patterns in worker.ts
 *   - Synchronous registration at module load is ideal for cron schedules
 */
// Guard against duplicate cron registrations if this module is evaluated
// more than once (e.g. hot-reload or multiple import paths in the same process).
let _task: ScheduledTask | null = null

function startDailyRetention(title: string): void {
  startJobOnce(
    'security-retention-daily',
    title,
    `security-retention-daily:${utcDateKey()}`,
    {},
    runSecurityRetentionJob,
  ).catch((err) => console.error('[security-retention] run failed to start:', err))
}

export function ensureSecurityRetentionJobScheduled(): ScheduledTask {
  if (_task) return _task

  // Set up daily cron schedule (4 AM)
  _task = cron.schedule('0 4 * * *', () => {
    startDailyRetention('Security retention: purge old events, incidents, action audits')
  })

  // Fire once on startup (catch-up) — a no-op if today's run already exists.
  startDailyRetention('Security retention: startup catch-up')
  return _task
}

/**
 * Run the retention job.
 * Called by startJob with a log function.
 */
export async function runSecurityRetentionJob(log: JobLogger): Promise<void> {
  await log('Starting security retention job')

  const now = new Date()
  const eventCutoff = new Date(now.getTime() - SECURITY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const incidentCutoff = new Date(now.getTime() - INCIDENT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const auditCutoff = new Date(now.getTime() - ACTION_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  // 1. Delete old security events — but exclude events still linked to open or
  //    active incidents (non-closed). Deleting live evidence would destroy the
  //    audit trail for ongoing investigations.
  const deletedEvents = await prisma.securityEvent.deleteMany({
    where: {
      createdAt: { lt: eventCutoff },
      OR: [
        { incidentId: null },
        { incident: { status: { in: ['closed'] } } },
      ],
    },
  })
  await log(`Security events purged: ${deletedEvents.count} rows older than ${eventCutoff.toISOString()}`)

  // 2. Delete old incidents — but ONLY if they have no SecurityEvent with
  //    lastSeen newer than the event cutoff. Otherwise an old Incident with a
  //    recently-updated recurring event would cascade-delete that event via
  //    the ON DELETE CASCADE FK introduced in 15_siem_cascade_on_delete,
  //    which would silently destroy data we explicitly chose to keep above.
  //    (Reviewer flag: option (b) from #414 MAJOR 1.)
  const deletedIncidents = await prisma.incident.deleteMany({
    where: {
      openedAt: { lt: incidentCutoff },
      events: {
        none: { lastSeen: { gt: eventCutoff } },
      },
    },
  })
  await log(`Incidents purged: ${deletedIncidents.count} rows older than ${incidentCutoff.toISOString()}`)

  // 3. Delete old action audits
  const deletedAudits = await prisma.actionAudit.deleteMany({
    where: { createdAt: { lt: auditCutoff } },
  })
  await log(`Action audits purged: ${deletedAudits.count} rows older than ${auditCutoff.toISOString()}`)

  // 4. Reopen CVE findings where accepted-risk period has expired
  const reopened = await prisma.vulnerabilityFinding.updateMany({
    where: {
      status: 'accepted',
      acceptedRiskExpiresAt: { lt: new Date() },
    },
    data: {
      status: 'open',
      acceptedRiskJustification: null,
      acceptedRiskExpiresAt: null,
    },
  })
  if (reopened.count > 0) {
    console.log(`[retention] Reopened ${reopened.count} expired accepted-risk CVE findings`)
  }

  await log(
    `Security retention complete: ${deletedEvents.count} events, ${deletedIncidents.count} incidents, ${deletedAudits.count} audits purged`,
  )
}

// ── Manual trigger API ────────────────────────────────────────────────────────

/**
 * POST /api/admin/security-retention/run
 *
 * Manually trigger the retention job (admin only).
 */
export async function runSecurityRetentionManual(): Promise<string> {
  return startJob(
    'security-retention-daily',
    'Manual security retention purge',
    {},
    runSecurityRetentionJob,
  )
}
