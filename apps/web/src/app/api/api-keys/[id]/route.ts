/**
 * DELETE /api/api-keys/[id]
 *
 * Revoke (delete) an API key.
 * Auth: session cookie OR x-api-key header
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { revokeApiKey, verifyApiKey } from '@/lib/api-key'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

type User = { id: string }

async function resolveUser(req: NextRequest): Promise<{ user?: User; error?: string; status?: number }> {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey) {
    const userId = await verifyApiKey(apiKey)
    if (userId) return { user: { id: userId } }
    return { error: 'Invalid API key', status: 401 }
  }
  const session = await getServerSession(authOptions)
  if (session?.user?.id) return { user: { id: session.user.id } }
  return { error: 'Unauthorized', status: 401 }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const result = await resolveUser(req)
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status! })
    }
    const { id } = await params
    const ok = await revokeApiKey(id, result.user!.id)

    if (!ok) {
      return NextResponse.json({ error: 'API key not found or unauthorized' }, { status: 404 })
    }

    // SOC2: [M-005] Audit API key revocation (non-blocking)
    logAudit({
      userId: result.user!.id,
      action: 'api_key_revoke',
      target: `api_key:${id}`,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req.headers),
    }).catch(() => {})

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
