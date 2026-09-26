/**
 * Security event retention — daily TTL job.
 *
 * Cleans up old security data according to retention policy:
 * - SecurityEvent: 30 days
 * - Incident: 365 days
 * - ActionAudit: 365 days
 * - Operational tables (AgentTrace, ToolExecution, logs, ...): see
 *   OPERATIONAL_RETENTION below; overridable via SystemSetting retention.<Model>.days
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
// Guard against duplicate cron registrations if this module is evaluated
// more than once (e.g. hot-reload or multiple import paths in the same process).
let _scheduled = false

export function ensureSecurityRetentionJobScheduled(): void {
  if (_scheduled) return
  _scheduled = true

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

  // 5. Operational tables that otherwise grow forever. A failure here must not
  //    mask the security purge above, so it is logged rather than rethrown.
  try {
    await purgeOperationalData(log)
  } catch (err) {
    await log(`Operational retention failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Operational data retention ────────────────────────────────────────────────
//
// Per-table retention, overridable with SystemSetting `retention.<Model>.days`
// (a number; 0 disables purging that table). Message (user chat history) is
// deliberately not purged. Deletes run in batches so a large backlog never
// holds long locks or one huge transaction.

const PURGE_BATCH_SIZE = 5000
const PURGE_MAX_BATCHES = 200 // caps one run at 1M rows per table; the rest goes next day

interface OperationalRetention {
  model: string
  defaultDays: number
  /** SQL predicate on the row, with $1 bound to the cutoff timestamp. Identifiers only — never user input. */
  where: string
}

const OPERATIONAL_RETENTION: OperationalRetention[] = [
  { model: 'AgentTrace', defaultDays: 90, where: `"createdAt" < $1` },
  // Pending/running executions are live approval state — never purged.
  { model: 'ToolExecution', defaultDays: 180, where: `"createdAt" < $1 AND "status" NOT IN ('pending', 'running')` },
  { model: 'HookExecutionLog', defaultDays: 30, where: `"startedAt" < $1` },
  { model: 'SkillExecutionLog', defaultDays: 90, where: `"createdAt" < $1` },
  { model: 'JobRun', defaultDays: 90, where: `"startedAt" < $1 AND "status" <> 'running'` },
  { model: 'WebhookDelivery', defaultDays: 30, where: `"receivedAt" < $1` },
  { model: 'AgentMessage', defaultDays: 90, where: `"createdAt" < $1` },
  { model: 'ClaudeInvocation', defaultDays: 90, where: `"createdAt" < $1` },
  { model: 'TaskEvent', defaultDays: 180, where: `"createdAt" < $1` },
  // Case records: only entries of investigations closed before the cutoff.
  {
    model: 'InvestigationTimeline',
    defaultDays: 365,
    where: `"createdAt" < $1 AND "investigationId" IN (
      SELECT "id" FROM "Investigation" WHERE "status" = 'closed' AND "closedAt" < $1)`,
  },
  // Cost/budget reporting looks back a year; keep a little over that.
  { model: 'AgentTokenUsage', defaultDays: 400, where: `"recordedAt" < $1` },
]

/** AgentTrace.fullContext holds the entire LLM prompt; drop it long before the row. */
const AGENT_TRACE_FULL_CONTEXT_DEFAULT_DAYS = 14

async function getRetentionDays(key: string, fallback: number): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key } })
  if (!row) return fallback
  const days = Number(row.value)
  return Number.isFinite(days) && days >= 0 ? Math.floor(days) : fallback
}

function cutoffFor(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

async function purgeInBatches(table: string, where: string, cutoff: Date): Promise<number> {
  let total = 0
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE ctid IN (SELECT ctid FROM "${table}" WHERE ${where} LIMIT ${PURGE_BATCH_SIZE})`,
      cutoff,
    )
    total += n
    if (n < PURGE_BATCH_SIZE) break
  }
  return total
}

export async function purgeOperationalData(log: JobLogger): Promise<void> {
  const ctxDays = await getRetentionDays('retention.AgentTrace.fullContextDays', AGENT_TRACE_FULL_CONTEXT_DEFAULT_DAYS)
  if (ctxDays > 0) {
    const cutoff = cutoffFor(ctxDays)
    let cleared = 0
    for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
      const n = await prisma.$executeRawUnsafe(
        `UPDATE "AgentTrace" SET "fullContext" = NULL WHERE ctid IN (
           SELECT ctid FROM "AgentTrace" WHERE "fullContext" IS NOT NULL AND "createdAt" < $1 LIMIT ${PURGE_BATCH_SIZE})`,
        cutoff,
      )
      cleared += n
      if (n < PURGE_BATCH_SIZE) break
    }
    await log(`AgentTrace.fullContext cleared on ${cleared} rows older than ${cutoff.toISOString()}`)
  }

  for (const { model, defaultDays, where } of OPERATIONAL_RETENTION) {
    const days = await getRetentionDays(`retention.${model}.days`, defaultDays)
    if (days === 0) {
      await log(`${model}: retention disabled (retention.${model}.days = 0)`)
      continue
    }
    const cutoff = cutoffFor(days)
    const n = await purgeInBatches(model, where, cutoff)
    await log(`${model} purged: ${n} rows older than ${cutoff.toISOString()} (${days}d)`)
  }
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
