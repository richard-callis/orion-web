import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET() {
  await requireAdmin()
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'system.watchers.paused' } })
  return NextResponse.json({ paused: setting?.value === true })
}

export async function POST(req: NextRequest) {
  await requireAdmin()
  const { paused } = await req.json() as { paused: boolean }
  await prisma.systemSetting.upsert({
    where:  { key: 'system.watchers.paused' },
    update: { value: paused },
    create: { key: 'system.watchers.paused', value: paused },
  })
  return NextResponse.json({ paused })
}
