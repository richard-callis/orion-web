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

  // M1 fix: validate baseUrl to prevent SSRF. A custom baseUrl would be used for
  // every subsequent LLM call — pointing it at 169.254.169.254 or internal hosts
  // would make all agent LLM calls hit internal services.
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return NextResponse.json({ error: 'baseUrl must use http or https' }, { status: 400 })
      }
      const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./]
      if (parsed.hostname === 'localhost' || PRIVATE.some(p => p.test(parsed.hostname))) {
        return NextResponse.json({ error: 'baseUrl must not point to a private or internal host' }, { status: 400 })
      }
    } catch {
      return NextResponse.json({ error: 'baseUrl is not a valid URL' }, { status: 400 })
    }
  }

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
