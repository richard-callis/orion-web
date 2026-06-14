import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { parseBodyOrError, UpdateSettingsSchema } from '@/lib/validate'
import { encrypt } from '@/lib/encryption'

// Keys matching these substrings are sensitive: encrypted at rest and redacted in GET responses.
const SENSITIVE_KEY_PATTERNS = ['token', 'secret', 'password', 'apikey', 'api_key', 'key', 'credential']

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => key.toLowerCase().includes(p))
}

export async function GET() {
  await requireAdmin()
  const rows = await prisma.systemSetting.findMany({ take: 500 })
  const result: Record<string, unknown> = {}
  for (const row of rows) {
    result[row.key] = isSensitiveKey(row.key) ? '••••' : row.value
  }
  return NextResponse.json(result)
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin()
  const result = await parseBodyOrError(req, UpdateSettingsSchema)
  if ('error' in result) return result.error
  const { data } = result

  // SOC2: encrypt sensitive values before storage
  let valueToStore: unknown
  if (isSensitiveKey(data.key)) {
    try {
      valueToStore = encrypt(data.value as string)
    } catch {
      return NextResponse.json({ error: 'Encryption key not configured' }, { status: 500 })
    }
  } else {
    valueToStore = data.value
  }

  const ops = [
    prisma.systemSetting.upsert({
      where: { key: data.key },
      update: { value: valueToStore as any },
      create: { key: data.key, value: valueToStore as any },
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
