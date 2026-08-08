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

// Keys readable by a gateway-token-authenticated service caller (e.g. the executor)
// WITHOUT an admin session. Deliberately narrow — this is the actual security boundary
// for the service-auth branch below, not a convenience list. Do NOT add anything
// secret-bearing here (vault.unsealKeys, vault.rootToken, API keys, etc.): unlike
// /api/admin/settings (which redacts sensitive values even for admins), this route
// returns the raw value, and middleware.ts explicitly excludes /api/admin/* from
// gateway-token access for exactly this reason (SOC2 [HIGH]) — a route outside that
// prefix must enforce the same boundary itself. The gateway token is also reachable by
// agent tool calls (see apps/gateway/src/builtin-tools/knowledge-graph.ts, which has a
// separate path-traversal bug that can hit this route with an agent-controlled key —
// tracked separately, not fixed here), so this allow-list is load-bearing, not defense
// in depth.
const SERVICE_READABLE_SETTING_KEYS = new Set([
  'system.room.execution',
  'system.room.security',
])

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  try {
    const { key } = await params

    if (!PUBLIC_SETTING_KEYS.has(key)) {
      // MINOR fix: any logged-in user could read any SystemSetting key, including
      // vault.unsealKeys (encrypted) and other sensitive config. Admin-gate all
      // non-public keys for session callers.
      //
      // requireServiceAuth also accepts a gateway-token-authenticated caller (returns
      // null) — the executor needs this to read system.room.execution/system.room.security
      // to know where to post execution-approval notices (see OrionClient.getSystemSetting,
      // notifyRoom). Unlike a session caller (who just needs role==='admin' to read ANY
      // non-public key), a gateway-authenticated caller is only trusted for the narrow
      // SERVICE_READABLE_SETTING_KEYS allow-list above.
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
      } else if (!SERVICE_READABLE_SETTING_KEYS.has(key)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }

    const setting = await prisma.systemSetting.findUnique({
      where: { key },
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
