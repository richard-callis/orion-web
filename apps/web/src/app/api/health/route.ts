import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { coreApi } from '@/lib/k8s'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  // SOC2: gate sensitive topology details behind authentication
  const user = await getCurrentUser()
  const isAuthenticated = !!user

  const [k8s, db] = await Promise.all([
    coreApi.listNamespace().then(() => true).catch(() => false),
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
  ])

  // Claude: check creds file exists AND has a valid session token
  let claude = false
  try {
    const { existsSync, readFileSync } = await import('fs')
    const credPath = process.env.CLAUDE_CREDENTIALS_PATH ?? '/claude-creds/.credentials.json'
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
  await Promise.all(extModels.map(async (m: any) => {
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
      extHealth[`${m.name} (${m.provider})`] = res.ok
    } catch { extHealth[`${m.name} (${m.provider})`] = false }
  }))

  // Worker health — inferred from task activity (worker has no direct health port)
  const [runningTasks, queuedTasks, lastActivity] = await Promise.all([
    prisma.task.count({ where: { status: 'in_progress' } }),
    prisma.task.count({ where: { status: 'pending' } }),
    prisma.task.findFirst({
      where: { status: 'in_progress' },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
  ])
  const workerActive = lastActivity
    ? (Date.now() - lastActivity.updatedAt.getTime()) < 5 * 60 * 1000
    : false

  const healthy = db  // k8s optional — not available in Docker-only deployments

  if (!isAuthenticated) {
    // Public callers only get a simple status — no internal topology
    return NextResponse.json({ status: healthy ? 'ok' : 'degraded' }, { status: healthy ? 200 : 503 })
  }

  return NextResponse.json({
    k8s, db, claude, externalModels: extHealth,
    worker: {
      running: runningTasks,
      queued: queuedTasks,
      lastActivityAt: lastActivity?.updatedAt.toISOString() ?? null,
      active: workerActive,
    },
  }, { status: healthy ? 200 : 503 })
}
