/**
 * Audit Retention Configuration — SOC2 [L-001]
 *
 * Allows admin to configure how long audit logs are retained.
 * Default: 365 days (1 year). Minimum: 90 days.
 *
 * The cleanup worker runs daily and deletes audit logs older than
 * the configured retention period.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

const KEY = 'audit.retentionDays'
const DEFAULT_DAYS = 365
const MIN_DAYS = 90
const MAX_DAYS = 2555 // ~7 years

/**
 * GET /api/admin/audit-retention
 * Returns current retention configuration.
 */
export async function GET() {
  await requireAdmin()
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } })
  const days = row ? (parseInt(row.value as string, 10) || DEFAULT_DAYS) : DEFAULT_DAYS

  return NextResponse.json({
    retentionDays: days,
    defaultDays: DEFAULT_DAYS,
    minDays: MIN_DAYS,
    maxDays: MAX_DAYS,
  })
}

/**
 * PATCH /api/admin/audit-retention
 * Updates the retention period.
 * Body: { retentionDays: number }
 */
export async function PATCH(req: NextRequest) {
  await requireAdmin()
  const body = await req.json().catch(() => ({}))
  const { retentionDays } = body as { retentionDays?: number }

  if (!Number.isInteger(retentionDays) || retentionDays < MIN_DAYS || retentionDays > MAX_DAYS) {
    return NextResponse.json(
      { error: `Retention must be an integer between ${MIN_DAYS} and ${MAX_DAYS} days` },
      { status: 400 },
    )
  }

  await prisma.systemSetting.upsert({
    where: { key: KEY },
    update: { value: retentionDays as unknown as never },
    create: { key: KEY, value: retentionDays as unknown as never },
  })

  return NextResponse.json({ ok: true, retentionDays })
}
