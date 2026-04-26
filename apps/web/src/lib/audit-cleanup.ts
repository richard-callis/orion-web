/**
 * Audit Log Cleanup Worker — SOC2 [L-001]
 *
 * Runs periodically (via cron or system scheduler) to purge audit logs
 * older than the configured retention period.
 *
 * Usage:
 *   npx tsx apps/web/src/lib/audit-cleanup.ts    # manual run
 *   crontab -e → 0 3 * * * cd /opt/orion && npx tsx apps/web/src/lib/audit-cleanup.ts
 *
 * Safety:
 * - Reads retention from SystemSetting (default 365 days)
 * - Minimum 90 days enforced
 * - Deletes in batches of 1000 to avoid long transactions
 * - Logs cleanup stats to stdout
 */

import { prisma } from './db'

const BATCH_SIZE = 1000

async function getRetentionDays(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: 'audit.retentionDays' } })
  if (!row) return 365
  const days = parseInt(String(row.value), 10)
  return isNaN(days) || days < 90 ? 365 : Math.min(days, 2555)
}

async function cleanupBatch(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86400000)

  // Find up to BATCH_SIZE records to delete
  const batch = await prisma.auditLog.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
    take: BATCH_SIZE,
  })

  if (batch.length === 0) return 0

  // Delete the batch by ID
  const result = await prisma.auditLog.deleteMany({
    where: { id: { in: batch.map((r: any) => r.id) } },
  })

  return result.count
}

async function main() {
  console.log('[audit-cleanup] Starting audit log cleanup...')

  const retentionDays = await getRetentionDays()
  const cutoff = new Date(Date.now() - retentionDays * 86400000)
  console.log(`[audit-cleanup] Retention: ${retentionDays} days (cutoff: ${cutoff.toISOString()})`)

  // Count records to be deleted
  const totalToDelete = await prisma.auditLog.count({
    where: { createdAt: { lt: cutoff } },
  })
  console.log(`[audit-cleanup] Records to delete: ${totalToDelete}`)

  if (totalToDelete === 0) {
    console.log('[audit-cleanup] Nothing to do.')
    return
  }

  let deleted = 0
  let iterations = 0
  while (deleted < totalToDelete) {
    const batch = await cleanupBatch(retentionDays)
    deleted += batch
    iterations++
    console.log(`[audit-cleanup] Batch ${iterations}: deleted ${batch} (total: ${deleted})`)
    if (batch === 0) break // no more records
  }

  console.log(`[audit-cleanup] Cleanup complete: deleted ${deleted} records in ${iterations} batches`)
}

main().catch((err: any) => {
  console.error('[audit-cleanup] Fatal error:', err)
  process.exit(1)
})
