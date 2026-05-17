import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { syncNebula } from '@/lib/nebula-loader'

/**
 * POST /api/nebulae/:id/sync — Trigger a manual sync for a Nebula
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await syncNebula(params.id)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
