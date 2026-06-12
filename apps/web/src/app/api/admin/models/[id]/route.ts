import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { clearContextLimitCache } from '@/lib/agent-context'
import { parseBodyOrError, UpdateExternalModelSchema } from '@/lib/validate'

function maskKey(key: string | null): string | null {
  if (!key) return null
  if (key.length <= 4) return '****'
  return '••••' + key.slice(-4)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin()
  const result = await parseBodyOrError(req, UpdateExternalModelSchema)
  if ('error' in result) return result.error
  const { data } = result

  const updateData: Record<string, unknown> = {}
  if (data.name        !== undefined) updateData.name        = data.name
  if (data.provider    !== undefined) updateData.provider    = data.provider
  if (data.baseUrl     !== undefined) updateData.baseUrl     = data.baseUrl
  if (data.modelId     !== undefined) updateData.modelId     = data.modelId
  if (data.enabled     !== undefined) updateData.enabled     = data.enabled
  if (data.selfHosted  !== undefined) updateData.selfHosted  = data.selfHosted
  if (data.timeoutSecs !== undefined) updateData.timeoutSecs = data.timeoutSecs
  if ('inputPricePer1M'  in data) updateData.inputPricePer1M  = data.inputPricePer1M
  if ('outputPricePer1M' in data) updateData.outputPricePer1M = data.outputPricePer1M
  if ('maxTokens'   in data) updateData.maxTokens   = data.maxTokens
  if ('contextSize' in data) updateData.contextSize = data.contextSize
  if ('temperature'   in data) updateData.temperature   = data.temperature
  if ('topP'          in data) updateData.topP          = data.topP
  if ('minP'          in data) updateData.minP          = data.minP
  if ('repeatPenalty' in data) updateData.repeatPenalty = data.repeatPenalty
  if ('seed'          in data) updateData.seed          = data.seed
  if (data.apiKey)              updateData.apiKey        = data.apiKey

  const model = await prisma.externalModel.update({
    where: { id: params.id },
    data: updateData,
  })

  // If contextSize changed, drop the cached limit so the next agent turn re-reads the new value.
  // Cache is keyed by "ext:<id>" (model-level), not baseUrl, so two models at the same server don't bleed.
  if ('contextSize' in data) clearContextLimitCache(`ext:${params.id}`)

  // SOC2: [M-005] Log model update (non-blocking)
  logAudit({
    userId: admin.id,
    action: 'model_update',
    target: `model:${params.id}`,
    detail: { name: model.name, provider: model.provider },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({ ...model, apiKey: maskKey(model.apiKey) })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin()
  const model = await prisma.externalModel.findUnique({
    where: { id: params.id },
    select: { name: true },
  })
  await prisma.externalModel.delete({ where: { id: params.id } })

  // SOC2: [M-005] Log model delete (non-blocking)
  logAudit({
    userId: admin.id,
    action: 'model_delete',
    target: `model:${params.id}`,
    detail: { name: model?.name },
    ipAddress: getClientIp(_req),
    userAgent: getUserAgent(_req.headers),
  }).catch(() => {})

  return new NextResponse(null, { status: 204 })
}
