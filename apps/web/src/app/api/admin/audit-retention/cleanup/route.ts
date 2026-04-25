/**
 * Manual Audit Log Cleanup — SOC2 [L-001]
 *
 * Allows admin to trigger immediate cleanup of expired audit logs.
 * Also exposes current cleanup stats (total audit logs, expired count).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET() {
  await requireAdmin()
  const retentionDays = await getRetentionDays()
  const cutoff = new Date(Date.now() - retentionDays * 86400000)

  const [totalCount, expiredCount] = await prisma.$transaction([
    prisma.auditLog.count(),
    prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } }),
  ])

  return NextResponse.json({
    retentionDays,
    cutoff: cutoff.toISOString(),
    totalAuditLogs: totalCount,
    expiredCount,
  })
}

export async function POST() {
  await requireAdmin()
  const retentionDays = await getRetentionDays()
  const cutoff = new Date(Date.now() - retentionDays * 86400000)

  const result = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })

  return NextResponse.json({
    ok: true,
    deleted: result.count,
    retentionDays,
    cutoff: cutoff.toISOString(),
  })
}

async function getRetentionDays(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: 'audit.retentionDays' } })
  if (!row) return 365
  const days = parseInt(String(row.value), 10)
  return isNaN(days) || days < 90 ? 365 : Math.min(days, 2555)
}
