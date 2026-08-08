import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

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
      // non-public keys for session callers.
      //
      // requireServiceAuth also accepts a gateway-token-authenticated caller (returns
      // null) — the executor needs this to read system.room.execution/system.room.security
      // to know where to post execution-approval notices (see OrionClient.getSystemSetting,
      // notifyRoom). A session caller must still be admin; gateway auth is trusted the same
      // way it already is for other non-admin-prefixed API routes in this codebase.
      let user
      try {
        user = await requireServiceAuth(req)
      } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      if (user) {
        if (user.role !== 'admin') {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (user.totpEnabled && !user.mfaVerified) {
          return NextResponse.json({ error: 'MFA verification required' }, { status: 401 })
        }
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
