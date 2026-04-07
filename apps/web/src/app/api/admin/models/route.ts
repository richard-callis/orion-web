import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

function maskKey(key: string | null): string | null {
  if (!key) return null
  if (key.length <= 4) return '****'
  return '••••' + key.slice(-4)
}

export async function GET() {
  const models = await prisma.externalModel.findMany({
    orderBy: { createdAt: 'asc' },
  })
  const masked = models.map(m => ({ ...m, apiKey: maskKey(m.apiKey) }))
  return NextResponse.json(masked)
}

export async function POST(req: NextRequest) {
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
  return NextResponse.json({ ...model, apiKey: maskKey(model.apiKey) }, { status: 201 })
}
