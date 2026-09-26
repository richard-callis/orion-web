/**
 * Daily Audit Export Job — SOC2 [L-001]
 *
 * Scheduled job that runs daily at 2 AM UTC to export audit logs to S3.
 * Integrates with the worker process for execution and monitoring.
 *
 * Configuration:
 * - Schedule: 0 2 * * * (2 AM UTC daily)
 * - Logs: Stored in BackgroundJob table
 * - Retries: On failure, logs are retained and job marked as failed
 * - Metrics: Success/failure tracked via job status
 *
 * Usage:
 * - Manual trigger: POST /api/admin/audit-export
 * - Automatic: node-cron in the worker process (jobs/scheduled-jobs.ts)
 *
 * Dependencies:
 * - AUDIT_EXPORT_S3_BUCKET — S3 bucket name (required)
 * - AUDIT_EXPORT_S3_REGION — AWS region (default: us-east-1)
 * - AUDIT_EXPORT_RETENTION_DAYS — Logs older than this are exported (default: 30)
 */

import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { prisma } from '@/lib/db'
import { startJobOnce, utcDateKey } from '@/lib/job-runner'
import { exportAuditLogs, loadAuditExportConfig, type AuditExportResult } from '@/lib/audit-export'
import { logAudit } from '@/lib/audit'

export type ExportJobMetadata = {
  retentionDays: number
  s3Bucket: string
  s3Region: string
  manifestPath: string
}

/**
 * Run the daily audit export job
 * Called by the worker process with a log function for status updates
 */
export async function runAuditExportJob(
  jobId: string,
  log: (msg: string) => Promise<void>
): Promise<void> {
  const startTime = Date.now()

  try {
    // Log job start
    await log(`Starting audit log export to S3...`)

    // Load configuration
    const config = loadAuditExportConfig()

    // Verify S3 bucket is configured
    if (!config.bucketName) {
      throw new Error('AUDIT_EXPORT_S3_BUCKET environment variable not set')
    }

    await log(
      `Configuration: bucket=${config.bucketName}, region=${config.region}, retention=${config.retentionDays}d`
    )

    // Run the export
    const result = await exportAuditLogs(config)

    // Handle export result
    if (!result.success) {
      throw new Error(result.error || 'Export failed for unknown reason')
    }

    const duration = Date.now() - startTime

    // Log success
    await log(`Export completed: ${result.recordCount} logs exported to ${result.s3Path}`)
    await log(`Manifest: ${result.manifestPath}`)
    await log(`Duration: ${duration}ms`)

    // Audit log the export
    try {
      await logAudit({
        userId: 'system',
        action: 'admin_action',
        target: 'audit_log_export',
        detail: {
          jobId,
          success: true,
          recordCount: result.recordCount,
          s3Path: result.s3Path,
          manifestPath: result.manifestPath,
          durationMs: duration,
          dateRange: result.dateRange,
        },
      })
    } catch {
      // Non-blocking — audit log failure should not fail the export job
      await log('Warning: Failed to log export to audit trail')
    }
  } catch (err) {
    const duration = Date.now() - startTime
    const error = err instanceof Error ? err.message : String(err)

    // Log error
    await log(`Export failed: ${error}`)
    await log(`Duration: ${duration}ms`)

    // Audit log the failure
    try {
      await logAudit({
        userId: 'system',
        action: 'admin_action',
        target: 'audit_log_export',
        detail: {
          jobId,
          success: false,
          error,
          durationMs: duration,
        },
      })
    } catch {
      // Non-blocking
      await log('Warning: Failed to log export failure to audit trail')
    }

    // Re-throw to mark job as failed
    throw new Error(error)
  }
}

let _task: ScheduledTask | null = null

function startDailyExport(title: string): void {
  const dedupeKey = `audit-export-daily:${utcDateKey()}`
  startJobOnce('audit-export-daily', title, dedupeKey, {}, async (log) => {
    await runAuditExportJob(dedupeKey, log)
    // AUDIT-001 retention (lib/worker-tasks.ts) only deletes when a successful
    // export happened within the last 25h — record that this one succeeded.
    await prisma.systemSetting.upsert({
      where:  { key: 'audit.lastExportTime' },
      update: { value: Date.now() },
      create: { key: 'audit.lastExportTime', value: Date.now() },
    })
  }).catch(err => console.error('[audit-export-job] run failed to start:', err))
}

/**
 * Schedule the daily audit export (02:00 UTC) in the worker process, with a
 * startup catch-up. Idempotent per UTC day via the job's dedupe key.
 *
 * Only scheduled when AUDIT_EXPORT_S3_BUCKET is explicitly set — without a
 * real destination every run would just fail. The manual trigger
 * (POST /api/admin/audit-export) is unaffected.
 *
 * Previously this created a 'queued' BackgroundJob row at web startup that
 * nothing ever executed.
 */
export function ensureAuditExportJobScheduled(): ScheduledTask | null {
  if (_task) return _task
  if (!process.env.AUDIT_EXPORT_S3_BUCKET) {
    console.log('[audit-export-job] AUDIT_EXPORT_S3_BUCKET not set — daily audit export disabled')
    return null
  }
  _task = cron.schedule('0 2 * * *', () => startDailyExport('Daily Audit Log Export to S3'), { timezone: 'UTC' })
  startDailyExport('Daily Audit Log Export to S3: startup catch-up')
  return _task
}
