import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'
import { validateBody, SetupAiProviderSchema } from '@/lib/validate'

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  if (body.skip) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  const data = validateBody(body, SetupAiProviderSchema)
  if (!data) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // Use provider default baseUrl if not provided
  const defaultBaseUrls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    openrouter: 'https://openrouter.ai/api/v1',
  }
  const baseUrl = data.baseUrl || defaultBaseUrls[data.provider] || ''

  const created = await prisma.externalModel.create({
    data: {
      name: data.name,
      provider: data.provider,
      baseUrl,
      apiKey: data.apiKey || null,
      modelId: data.modelId,
      enabled: true,
    },
  })

  // Automatically make the wizard-configured model the system default
  await prisma.systemSetting.upsert({
    where:  { key: 'model.default' },
    update: { value: `ext:${created.id}` },
    create: { key: 'model.default', value: `ext:${created.id}` },
  })

  return NextResponse.json({ ok: true })
}
