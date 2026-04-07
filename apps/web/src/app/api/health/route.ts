import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { coreApi } from '@/lib/k8s'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [k8s, db] = await Promise.all([
    coreApi.listNamespace().then(() => true).catch(() => false),
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
  ])

  // Claude: check creds file exists AND has a valid session token
  let claude = false
  try {
    const { existsSync, readFileSync } = await import('fs')
    const credPath = process.env.CLAUDE_CREDENTIALS_PATH ?? '/claude-creds/.claude'
    if (existsSync(credPath)) {
      const raw = readFileSync(credPath, 'utf8')
      const parsed = JSON.parse(raw)
      // Valid if it has a non-empty claudeAiOauth or oauthToken
      const token = parsed?.claudeAiOauth?.accessToken ?? parsed?.oauthToken ?? parsed?.accessToken ?? ''
      claude = typeof token === 'string' && token.length > 10
    }
  } catch { claude = false }

  // External models health
  const extModels = await prisma.externalModel.findMany({ where: { enabled: true } })
  const extHealth: Record<string, boolean> = {}
  await Promise.all(extModels.map(async m => {
    try {
      const url = m.provider === 'openai' || m.provider === 'custom'
        ? `${m.baseUrl}/models`
        : m.provider === 'ollama'
        ? `${m.baseUrl}/api/tags`
        : `${m.baseUrl}/v1/models`
      const res = await fetch(url, {
        headers: m.apiKey ? { Authorization: `Bearer ${m.apiKey}` } : {},
        signal: AbortSignal.timeout(3000),
      })
      extHealth[`ext:${m.id}`] = res.ok
    } catch { extHealth[`ext:${m.id}`] = false }
  }))

  const healthy = k8s && db
  return NextResponse.json({ k8s, db, claude, externalModels: extHealth }, { status: healthy ? 200 : 503 })
}
