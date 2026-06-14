import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// Keys readable by any logged-in user (safe, non-sensitive UI config)
const PUBLIC_SETTING_KEYS = new Set([
  'site.name',
  'site.logo',
  'site.theme',
  'cache.snapshot.ttl',
  'cache.env.ttl',
  'feature.dream.enabled',
  'feature.nebula.enabled',
])

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    if (!PUBLIC_SETTING_KEYS.has((await params).key)) {
      // MINOR fix: any logged-in user could read any SystemSetting key, including
      // vault.unsealKeys (encrypted) and other sensitive config. Admin-gate all
      // non-public keys.
      try { await requireAdmin() } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }

    const setting = await prisma.systemSetting.findUnique({
      where: { key: (await params).key },
    })

    if (!setting) {
      return NextResponse.json({ error: 'Setting not found' }, { status: 404 })
    }

    return NextResponse.json({ key: setting.key, value: setting.value })
  } catch (error) {
    console.error('Error getting system setting:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
