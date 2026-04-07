import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()

  if (body.skip) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  const { name, provider, baseUrl, apiKey, modelId } = body

  if (!name || !provider || !baseUrl || !modelId) {
    return NextResponse.json(
      { error: 'name, provider, baseUrl, and modelId are required' },
      { status: 400 }
    )
  }

  await prisma.externalModel.create({
    data: {
      name,
      provider,
      baseUrl,
      apiKey: apiKey || null,
      modelId,
      enabled: true,
    },
  })

  return NextResponse.json({ ok: true })
}
