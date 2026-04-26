/**
 * Worker Background Tasks
 *
 * Scheduled tasks that run periodically in the worker process:
 * - Cleanup old audit logs (per retention policy)
 * - Validate system health
 * - Perform maintenance operations
 *
 * SOC2 #AUDIT-001: Automated audit log retention
 */

import { prisma } from './db'

/**
 * Run audit log cleanup.
 * Called daily by the worker process.
 */
export async function cleanupAuditLogs(): Promise<{ deleted: number; durationMs: number }> {
  const startTime = Date.now()

  try {
    // Get retention policy from system settings
    const retentionSetting = await prisma.systemSetting.findUnique({
      where: { key: 'audit.retentionDays' },
    })

    const retentionDays = retentionSetting
      ? parseInt(String(retentionSetting.value), 10)
      : 365

    // Enforce minimum retention (90 days per SOC2)
    const safeDays = Math.max(retentionDays, 90)

    // Calculate cutoff date
    const cutoff = new Date(Date.now() - safeDays * 86400000)

    // Count records to delete
    const count = await prisma.auditLog.count({
      where: { createdAt: { lt: cutoff } },
    })

    if (count === 0) {
      console.log(`[audit-cleanup] No logs to delete (retention: ${safeDays}d)`)
      return { deleted: 0, durationMs: Date.now() - startTime }
    }

    // Delete in batches to avoid long transactions
    const BATCH_SIZE = 1000
    let deleted = 0

    for (let batch = 0; batch < Math.ceil(count / BATCH_SIZE); batch++) {
      // Find IDs of records to delete
      const toDelete = await prisma.auditLog.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      })

      if (toDelete.length === 0) break

      // Delete those records
      const batch_result = await prisma.auditLog.deleteMany({
        where: { id: { in: toDelete.map(r => r.id) } },
      })
      deleted += batch_result.count

      console.log(
        `[audit-cleanup] Batch ${batch + 1}: deleted ${batch_result.count} (total: ${deleted})`
      )
    }

    console.log(`[audit-cleanup] Complete: deleted ${deleted} logs (cutoff: ${cutoff.toISOString()})`)

    // Log the cleanup event itself
    await prisma.auditLog.create({
      data: {
        action: 'AUDIT_LOG_CLEANUP',
        target: 'System',
        userId: 'system',
        detail: {
          deleted_count: deleted,
          cutoff_date: cutoff.toISOString(),
          retention_days: safeDays,
        } as any,
      },
    })

    return { deleted, durationMs: Date.now() - startTime }
  } catch (error) {
    console.error('[audit-cleanup] Error:', error)
    throw error
  }
}

/**
 * Run all worker maintenance tasks.
 * Called periodically (default: daily) by the worker.
 */
export async function runMaintenanceTasks(): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = []

  // Cleanup audit logs
  try {
    const result = await cleanupAuditLogs()
    console.log(`[maintenance] Audit cleanup: ${result.deleted} deleted in ${result.durationMs}ms`)
  } catch (err) {
    const msg = `Audit cleanup failed: ${err instanceof Error ? err.message : String(err)}`
    console.error(`[maintenance] ${msg}`)
    errors.push(msg)
  }

  return {
    success: errors.length === 0,
    errors,
  }
}
