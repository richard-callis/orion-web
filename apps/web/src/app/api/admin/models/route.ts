import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { parseBodyOrError, CreateExternalModelSchema } from '@/lib/validate'

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
  const masked = models.map((m: any) => ({ ...m, apiKey: maskKey(m.apiKey) }))
  return NextResponse.json(masked)
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin()
  const result = await parseBodyOrError(req, CreateExternalModelSchema)
  if ('error' in result) return result.error
  const { data } = result

  const model = await prisma.externalModel.create({
    data: {
      name:        data.name,
      provider:    data.provider,
      baseUrl:     data.baseUrl,
      apiKey:      data.apiKey ?? null,
      modelId:     data.modelId,
      enabled:     data.enabled ?? true,
      timeoutSecs:   data.timeoutSecs ?? 120,
      maxTokens:     data.maxTokens   ?? null,
      contextSize:   data.contextSize ?? null,
      temperature:   data.temperature   ?? null,
      topP:          data.topP          ?? null,
      minP:          data.minP          ?? null,
      repeatPenalty: data.repeatPenalty ?? null,
      seed:          data.seed          ?? null,
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
