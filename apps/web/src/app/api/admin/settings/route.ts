import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { parseBodyOrError, UpdateSettingsSchema } from '@/lib/validate'

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
  const result = await parseBodyOrError(req, UpdateSettingsSchema)
  if ('error' in result) return result.error
  const { data } = result

  const ops = [
    prisma.systemSetting.upsert({
      where: { key: data.key },
      update: { value: data.value as Parameters<typeof prisma.systemSetting.create>[0]['data']['value'] },
      create: { key: data.key, value: data.value as Parameters<typeof prisma.systemSetting.create>[0]['data']['value'] },
    })
  ]

  await prisma.$transaction(ops)

  // SOC2: [M-005] Log settings update (non-blocking)
  logAudit({
    userId: admin.id,
    action: 'settings_update',
    target: 'settings:batch',
    detail: { keys: [data.key] },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({ ok: true })
}
