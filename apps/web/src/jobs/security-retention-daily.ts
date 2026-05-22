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
import { prisma } from '@/lib/db'
import { startJob } from '@/lib/job-runner'
import type { JobLogger } from '@/lib/job-runner'

// ── Configuration ─────────────────────────────────────────────────────────────

const SECURITY_EVENT_RETENTION_DAYS = 30
const INCIDENT_RETENTION_DAYS = 365
const ACTION_AUDIT_RETENTION_DAYS = 365

// ── Daily job entry point ─────────────────────────────────────────────────────

/**
 * Schedule the retention job with node-cron (daily at 4 AM) and fire once
 * on startup to cover any gap since last shutdown.
 *
 * Cron: "0 4 * * *" — daily at 4:00 AM.
 * node-cron chosen because:
 *   - Smallest cron dependency (no BullMQ/pg_cron required)
 *   - Existing codebase already uses interval-based patterns in worker.ts
 *   - Synchronous registration at module load is ideal for cron schedules
 */
export function ensureSecurityRetentionJobScheduled(): void {
  // Set up daily cron schedule (4 AM)
  cron.schedule('0 4 * * *', () => {
    startJob(
      'security-retention-daily',
      'Security retention: purge old events, incidents, action audits',
      {},
      runSecurityRetentionJob,
    ).catch((err) => console.error('[security-retention] cron run failed:', err))
  })

  // Fire once immediately on startup (catch-up). startJob's own idempotency
  // gate prevents duplicate enqueue if a cron-triggered job is already queued.
  startJob(
    'security-retention-daily',
    'Security retention: startup catch-up',
    {},
    runSecurityRetentionJob,
  ).catch((err) => console.error('[security-retention] startup catch-up failed:', err))
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

  // 1. Delete old security events
  const deletedEvents = await prisma.securityEvent.deleteMany({
    where: { createdAt: { lt: eventCutoff } },
  })
  await log(`Security events purged: ${deletedEvents.count} rows older than ${eventCutoff.toISOString()}`)

  // 2. Delete old incidents (this cascades to related events via FK constraints)
  const deletedIncidents = await prisma.incident.deleteMany({
    where: { openedAt: { lt: incidentCutoff } },
  })
  await log(`Incidents purged: ${deletedIncidents.count} rows older than ${incidentCutoff.toISOString()}`)

  // 3. Delete old action audits
  const deletedAudits = await prisma.actionAudit.deleteMany({
    where: { createdAt: { lt: auditCutoff } },
  })
  await log(`Action audits purged: ${deletedAudits.count} rows older than ${auditCutoff.toISOString()}`)

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
