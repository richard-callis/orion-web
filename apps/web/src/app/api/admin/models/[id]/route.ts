import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

function maskKey(key: string | null): string | null {
  if (!key) return null
  if (key.length <= 4) return '****'
  return '••••' + key.slice(-4)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireAdmin()
  const body = await req.json()

  // Only update apiKey if a new one was provided
  const updateData: Record<string, unknown> = {}
  if (body.name        !== undefined) updateData.name        = body.name
  if (body.provider    !== undefined) updateData.provider    = body.provider
  if (body.baseUrl     !== undefined) updateData.baseUrl     = body.baseUrl
  if (body.modelId     !== undefined) updateData.modelId     = body.modelId
  if (body.enabled     !== undefined) updateData.enabled     = body.enabled
  if (body.timeoutSecs !== undefined) updateData.timeoutSecs = body.timeoutSecs
  if (body.apiKey)                    updateData.apiKey      = body.apiKey

  const model = await prisma.externalModel.update({
    where: { id: params.id },
    data: updateData,
  })
  return NextResponse.json({ ...model, apiKey: maskKey(model.apiKey) })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await requireAdmin()
  await prisma.externalModel.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
