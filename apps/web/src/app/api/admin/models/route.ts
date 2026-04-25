import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

function maskKey(key: string | null): string | null {
  if (!key) return null
  if (key.length <= 4) return '****'
  return '••••' + key.slice(-4)
}

export async function GET() {
  await requireAdmin()
  const models = await prisma.externalModel.findMany({
    orderBy: { createdAt: 'asc' },
  })
  const masked = models.map(m => ({ ...m, apiKey: maskKey(m.apiKey) }))
  return NextResponse.json(masked)
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin()
  const body = await req.json()
  const model = await prisma.externalModel.create({
    data: {
      name:        body.name,
      provider:    body.provider,
      baseUrl:     body.baseUrl,
      apiKey:      body.apiKey ?? null,
      modelId:     body.modelId,
      enabled:     body.enabled ?? true,
      timeoutSecs: body.timeoutSecs ?? 120,
    },
  })

  // SOC2: [M-005] Log model create (non-blocking)
  logAudit({
    userId: admin.id,
    action: 'model_create',
    target: `model:${model.id}`,
    detail: { name: model.name, provider: model.provider },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({ ...model, apiKey: maskKey(model.apiKey) }, { status: 201 })
}
