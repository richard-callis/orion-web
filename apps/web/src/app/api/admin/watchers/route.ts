import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError, UpdateWatcherPauseSchema } from '@/lib/validate'

export async function GET() {
  await requireAdmin()
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'system.watchers.paused' } })
  return NextResponse.json({ paused: setting?.value === true })
}

export async function POST(req: NextRequest) {
  await requireAdmin()
  const parsed = await parseBodyOrError(req, UpdateWatcherPauseSchema)
  if ('error' in parsed) return parsed.error
  const { paused } = parsed.data
  await prisma.systemSetting.upsert({
    where:  { key: 'system.watchers.paused' },
    update: { value: paused },
    create: { key: 'system.watchers.paused', value: paused },
  })
  return NextResponse.json({ paused })
}
