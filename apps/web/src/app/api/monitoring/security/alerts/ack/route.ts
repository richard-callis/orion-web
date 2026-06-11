import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const ids = (body as any)?.ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: 'ids array too large (max 500)' }, { status: 400 })
  }
  if (ids.some((id: unknown) => typeof id !== 'string')) {
    return NextResponse.json({ error: 'ids must be an array of strings' }, { status: 400 })
  }

  const acknowledgedAt = new Date()

  await prisma.securityEvent.updateMany({
    where: { id: { in: ids } },
    data: { acknowledged: true, acknowledgedAt },
  })

  return NextResponse.json({ acknowledged: ids.length })
}
