import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { seedSystemNebula } from '@/lib/seed-system-nebula'

/**
 * POST /api/nebulae/seed-system — Manually trigger system Nebula seeding
 * Useful for re-triggering after the git provider is configured post-wizard.
 */
export async function POST() {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await seedSystemNebula()
  return NextResponse.json({ ok: true })
}
