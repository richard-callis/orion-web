import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** GET — Load security source configuration from SecurityConfig table */
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const envId = process.env.ENVIRONMENT_ID || ''

  const configs = await prisma.securityConfig.findMany({
    where: envId ? { environmentId: envId } : {},
    select: { key: true, value: true },
  })

  const config: Record<string, string> = {}
  for (const c of configs) {
    config[c.key] = c.value
  }

  return NextResponse.json({ config })
}

/** PUT — Save security source configuration to SecurityConfig table */
export async function PUT(request: Request) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const envId = process.env.ENVIRONMENT_ID || ''
  const config = await request.json() as Record<string, string>

  const updates = Object.entries(config).map(([key, value]) =>
    prisma.securityConfig.upsert({
      where: {
        environmentId_key: { environmentId: envId, key },
      },
      update: { value },
      create: { environmentId: envId, key, value },
    }).catch(() =>
      prisma.securityConfig.upsert({
        where: {
          environmentId_key: { environmentId: '' as unknown as string, key },
        },
        update: { value },
        create: { key, value },
      })
    )
  )

  await Promise.allSettled(updates)

  // Reload to return saved config
  const saved = await prisma.securityConfig.findMany({
    where: envId ? { environmentId: envId } : {},
    select: { key: true, value: true },
  })

  const result: Record<string, string> = {}
  for (const c of saved) {
    result[c.key] = c.value
  }

  return NextResponse.json({ config: result })
}
