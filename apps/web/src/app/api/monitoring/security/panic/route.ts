/**
 * GET  /api/monitoring/security/panic  — read panic mode state
 * PUT  /api/monitoring/security/panic  — toggle panic mode { active: boolean }
 *
 * Panic mode downgrades all auto/notify actions to approve, forcing human
 * review during an active incident. Backed by the __panic_mode__ ActionPolicy
 * row seeded at startup.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const PANIC_ACTION_TYPE = '__panic_mode__'

async function getPanicState(): Promise<boolean> {
  const policy = await prisma.actionPolicy.findUnique({
    where: { actionType: PANIC_ACTION_TYPE },
    select: { defaultTier: true },
  })
  // Convention: defaultTier='approve' means panic is ON; 'auto' means OFF
  return policy?.defaultTier === 'approve'
}

export async function GET() {
  const active = await getPanicState()
  return NextResponse.json({ active })
}

export async function PUT(req: NextRequest) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { active?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  if (typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'Body must be { active: boolean }' }, { status: 400 })
  }

  await prisma.actionPolicy.upsert({
    where: { actionType: PANIC_ACTION_TYPE },
    update: { defaultTier: body.active ? 'approve' : 'auto', updatedBy: 'admin' },
    create: {
      actionType: PANIC_ACTION_TYPE,
      defaultTier: body.active ? 'approve' : 'auto',
      targetPatterns: [],
      updatedBy: 'admin',
    },
  })

  return NextResponse.json({ active: body.active })
}
