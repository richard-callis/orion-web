import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export async function GET() {
  await requireAdmin()
  const rows = await prisma.systemSetting.findMany()
  const result: Record<string, unknown> = {}
  for (const row of rows) {
    result[row.key] = row.value
  }
  return NextResponse.json(result)
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin()
  const body: Record<string, unknown> = await req.json()

  const ops = Object.entries(body).map(([key, value]) =>
    prisma.systemSetting.upsert({
      where: { key },
      update: { value: value as Parameters<typeof prisma.systemSetting.create>[0]['data']['value'] },
      create: { key, value: value as Parameters<typeof prisma.systemSetting.create>[0]['data']['value'] },
    })
  )

  await prisma.$transaction(ops)

  // SOC2: [M-005] Log settings update (non-blocking)
  logAudit({
    userId: admin.id,
    action: 'settings_update',
    target: 'settings:batch',
    detail: { keys: Object.keys(body) },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({ ok: true })
}
