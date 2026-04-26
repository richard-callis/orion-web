/**
 * Manual Audit Log Cleanup — SOC2 [L-001]
 *
 * Allows admin to trigger immediate cleanup of expired audit logs.
 * Verifies that logs have been exported to S3 before allowing deletion.
 * Also exposes current cleanup stats (total audit logs, expired count).
 *
 * Flow:
 * 1. GET /api/admin/audit-retention/cleanup — Returns cleanup stats
 * 2. POST /api/admin/audit-retention/cleanup — Deletes expired logs
 *    - Checks if S3 export succeeded recently (last 24 hours)
 *    - If no recent export, starts an export job first
 *    - Only deletes after export succeeds
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { exportAuditLogs, loadAuditExportConfig } from '@/lib/audit-export'
import { logAudit } from '@/lib/audit'

export async function GET() {
  await requireAdmin()
  const retentionDays = await getRetentionDays()
  const cutoff = new Date(Date.now() - retentionDays * 86400000)

  const [totalCount, expiredCount] = await prisma.$transaction([
    prisma.auditLog.count(),
    prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } }),
  ])

  // Check if export has been run recently
  const lastExport = await getLastExportTime()
  const canCleanup = lastExport && Date.now() - lastExport.getTime() < 24 * 60 * 60 * 1000

  return NextResponse.json({
    retentionDays,
    cutoff: cutoff.toISOString(),
    totalAuditLogs: totalCount,
    expiredCount,
    lastExportTime: lastExport?.toISOString() || null,
    canCleanupWithoutExport: canCleanup,
  })
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin()
  const retentionDays = await getRetentionDays()
  const cutoff = new Date(Date.now() - retentionDays * 86400000)

  // Check if logs have been exported recently
  const lastExport = await getLastExportTime()
  const hasRecentExport = lastExport && Date.now() - lastExport.getTime() < 24 * 60 * 60 * 1000

  if (!hasRecentExport) {
    // Run export first before allowing deletion
    try {
      const config = loadAuditExportConfig()

      // Verify S3 is configured
      if (!config.bucketName) {
        return NextResponse.json(
          {
            error: 'S3 export not configured (AUDIT_EXPORT_S3_BUCKET not set)',
            requiresExport: true,
            message: 'Please configure S3 bucket in environment variables',
          },
          { status: 400 }
        )
      }

      // Run the export
      const result = await exportAuditLogs(config)

      if (!result.success) {
        // Log the failed export attempt
        await logAudit({
          userId: user.id,
          action: 'admin_action',
          target: 'audit_log_cleanup',
          detail: {
            action: 'cleanup_requested',
            exportFailed: true,
            error: result.error,
          },
        })

        return NextResponse.json(
          {
            error: `Export failed before cleanup: ${result.error}`,
            requiresExport: true,
          },
          { status: 500 }
        )
      }

      // Record the export time
      await recordExportTime()

      // Log the successful export and cleanup
      await logAudit({
        userId: user.id,
        action: 'admin_action',
        target: 'audit_log_cleanup',
        detail: {
          action: 'cleanup_requested_with_export',
          exportedRecords: result.recordCount,
          s3Path: result.s3Path,
        },
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await logAudit({
        userId: user.id,
        action: 'admin_action',
        target: 'audit_log_cleanup',
        detail: {
          action: 'cleanup_failed',
          error,
        },
      })

      return NextResponse.json(
        {
          error: `Failed to export logs before cleanup: ${error}`,
          requiresExport: true,
        },
        { status: 500 }
      )
    }
  }

  // Delete expired logs
  const result = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })

  // Log the cleanup action
  await logAudit({
    userId: user.id,
    action: 'admin_action',
    target: 'audit_log_cleanup',
    detail: {
      action: 'logs_deleted',
      deletedCount: result.count,
      retentionDays,
      cutoff: cutoff.toISOString(),
    },
  })

  return NextResponse.json({
    ok: true,
    deleted: result.count,
    retentionDays,
    cutoff: cutoff.toISOString(),
    exportedBefore: hasRecentExport,
  })
}

async function getRetentionDays(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: 'audit.retentionDays' } })
  if (!row) return 365
  const days = parseInt(String(row.value), 10)
  return isNaN(days) || days < 90 ? 365 : Math.min(days, 2555)
}

/**
 * Get the timestamp of the last successful audit export
 */
async function getLastExportTime(): Promise<Date | null> {
  try {
    const row = await prisma.systemSetting.findUnique({
      where: { key: 'audit.lastExportTime' },
    })
    if (!row) return null
    const timestamp = parseInt(String(row.value), 10)
    return isNaN(timestamp) ? null : new Date(timestamp)
  } catch {
    return null
  }
}

/**
 * Record the timestamp of a successful export
 */
async function recordExportTime(): Promise<void> {
  try {
    await prisma.systemSetting.upsert({
      where: { key: 'audit.lastExportTime' },
      create: { key: 'audit.lastExportTime', value: Date.now() },
      update: { value: Date.now() },
    })
  } catch {
    // Non-blocking — failure to record doesn't prevent cleanup
  }
}
