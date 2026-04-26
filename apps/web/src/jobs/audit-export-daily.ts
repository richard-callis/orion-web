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
 * - Automatic: Worker polls and executes at scheduled time
 *
 * Dependencies:
 * - AUDIT_EXPORT_S3_BUCKET — S3 bucket name (required)
 * - AUDIT_EXPORT_S3_REGION — AWS region (default: us-east-1)
 * - AUDIT_EXPORT_RETENTION_DAYS — Logs older than this are exported (default: 30)
 */

import { prisma } from '@/lib/db'
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

/**
 * Get the next scheduled run time for the daily export
 * Runs at 2 AM UTC every day
 */
export function getNextExportSchedule(): Date {
  const now = new Date()
  const next = new Date(now.getTime() + 24 * 60 * 60 * 1000) // Tomorrow

  // Set to 2 AM UTC
  next.setUTCHours(2, 0, 0, 0)

  // If it's before 2 AM UTC today, run today
  const today = new Date()
  today.setUTCHours(2, 0, 0, 0)
  if (today > now) {
    return today
  }

  return next
}

/**
 * Check if it's time to run the export job
 * Used by worker to decide if it should execute the scheduled job
 */
export function isTimeForExport(): boolean {
  const now = new Date()
  const hour = now.getUTCHours()
  const minute = now.getUTCMinutes()

  // Run between 2:00 AM and 2:30 AM UTC
  // This allows a 30-minute window for the job to complete
  return hour === 2 && minute < 30
}

/**
 * Create or get the daily audit export job
 * Called during system startup to ensure the job exists in the scheduler
 */
export async function ensureAuditExportJobScheduled(): Promise<void> {
  try {
    // Check if export job already exists in the database
    const existing = await prisma.backgroundJob.findFirst({
      where: {
        type: 'audit-export-daily',
        status: { in: ['queued', 'running'] },
      },
    })

    if (existing) {
      // Job already scheduled
      return
    }

    // Create a new scheduled job (will be picked up by worker on next poll)
    const config = loadAuditExportConfig()

    await prisma.backgroundJob.create({
      data: {
        id: `audit-export-${Date.now()}`,
        type: 'audit-export-daily',
        title: 'Daily Audit Log Export to S3',
        status: 'queued',
        metadata: {
          retentionDays: config.retentionDays,
          s3Bucket: config.bucketName,
          s3Region: config.region,
          manifestPath: config.manifestPath,
        } as ExportJobMetadata,
      },
    })

    console.log('[audit-export-job] Scheduled daily audit export job')
  } catch (err) {
    // Non-blocking — if scheduling fails, it will be attempted again on next startup
    console.error('[audit-export-job] Failed to schedule export job:', err)
  }
}
