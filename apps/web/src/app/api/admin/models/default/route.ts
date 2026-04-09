import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// PUT /api/admin/models/default  — set or clear the default model
export async function PUT(req: NextRequest) {
  const { modelId } = await req.json()

  if (!modelId) {
    // Clear default
    await prisma.systemSetting.deleteMany({ where: { key: 'model.default' } })
    return NextResponse.json({ defaultModelId: null })
  }

  await prisma.systemSetting.upsert({
    where:  { key: 'model.default' },
    update: { value: modelId },
    create: { key: 'model.default', value: modelId },
  })

  return NextResponse.json({ defaultModelId: modelId })
}
