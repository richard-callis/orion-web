/**
 * Manual Audit Export Endpoint — SOC2 [L-001]
 *
 * Allows admins to manually trigger audit log export to S3.
 * Useful for on-demand backups or testing the export pipeline.
 *
 * POST /api/admin/audit-export
 * - Triggers export of logs older than retention period
 * - Returns job ID for monitoring progress
 * - Uses background job system for async execution
 *
 * GET /api/admin/audit-export?jobId=<id>
 * - Check status of an export job
 * - Returns job details and logs
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { exportAuditLogs, loadAuditExportConfig } from '@/lib/audit-export'
import { logAudit } from '@/lib/audit'
import { startJob } from '@/lib/job-runner'

export async function GET(req: NextRequest) {
  const user = await requireAdmin()
  const { searchParams } = new URL(req.url)
  const jobId = searchParams.get('jobId')

  if (!jobId) {
    return NextResponse.json(
      { error: 'jobId query parameter required' },
      { status: 400 }
    )
  }

  const job = await prisma.backgroundJob.findUnique({
    where: { id: jobId },
  })

  if (!job) {
    return NextResponse.json(
      { error: 'Job not found' },
      { status: 404 }
    )
  }

  return NextResponse.json({
    id: job.id,
    type: job.type,
    title: job.title,
    status: job.status,
    logs: job.logs,
    metadata: job.metadata,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() || null,
  })
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin()

  // Start export job in background
  const jobId = await startJob(
    'audit-export',
    'Manual Audit Log Export to S3',
    {
      metadata: {
        triggeredBy: user.id,
        triggeredAt: new Date().toISOString(),
      },
    },
    async (log) => {
      try {
        const config = loadAuditExportConfig()

        // Verify S3 is configured
        if (!config.bucketName) {
          throw new Error('AUDIT_EXPORT_S3_BUCKET not configured')
        }

        await log(`Starting audit log export...`)
        await log(
          `Configuration: bucket=${config.bucketName}, region=${config.region}, retention=${config.retentionDays}d`
        )

        // Run the export
        const result = await exportAuditLogs(config)

        if (!result.success) {
          throw new Error(result.error || 'Export failed')
        }

        await log(`Successfully exported ${result.recordCount} logs to ${result.s3Path}`)
        await log(`Manifest: ${result.manifestPath}`)

        // Log the export
        await logAudit({
          userId: user.id,
          action: 'admin_action',
          target: 'manual_audit_export',
          detail: {
            jobId,
            success: true,
            recordCount: result.recordCount,
            s3Path: result.s3Path,
            manifestPath: result.manifestPath,
            dateRange: result.dateRange,
          },
        })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        await log(`Export failed: ${error}`)

        // Log the failure
        await logAudit({
          userId: user.id,
          action: 'admin_action',
          target: 'manual_audit_export',
          detail: {
            jobId,
            success: false,
            error,
          },
        })

        throw new Error(error)
      }
    }
  )

  return NextResponse.json(
    {
      ok: true,
      jobId,
      message: 'Export job started',
      checkStatusUrl: `/api/admin/audit-export?jobId=${jobId}`,
    },
    { status: 202 }
  )
}
