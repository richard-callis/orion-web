import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// PUT /api/admin/models/default  — set or clear the default model
export async function PUT(req: NextRequest) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
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
