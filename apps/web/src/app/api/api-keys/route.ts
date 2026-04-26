/**
 * POST /api/api-keys & GET /api/api-keys
 *
 * API key management for admin users.
 * POST: Create a new API key
 * GET: List all API keys for the current user
 *
 * Auth: session cookie (via requireAdmin) OR x-api-key header
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createApiKey, listUserKeys, verifyApiKey } from '@/lib/api-key'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

type User = { id: string }

async function resolveUser(req: NextRequest): Promise<{ user?: User; error?: string; status?: number }> {
  // Try API key header first
  const apiKey = req.headers.get('x-api-key')
  if (apiKey) {
    const userId = await verifyApiKey(apiKey)
    if (userId) {
      return { user: { id: userId } }
    }
    return { error: 'Invalid API key', status: 401 }
  }
  // Fall back to session cookie
  const session = await getServerSession(authOptions)
  if (session?.user?.id) {
    return { user: { id: session.user.id } }
  }
  return { error: 'Unauthorized', status: 401 }
}

// GET /api/api-keys — list all keys for the current user
export async function GET(req: NextRequest) {
  try {
    const result = await resolveUser(req)
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status! })
    }
    const keys = await listUserKeys(result.user!.id)

    // Strip sensitive fields — only show what's safe to display
    return NextResponse.json({
      keys: keys.map(k => ({
        id: k.id,
        hashPrefix: k.hashPrefix,
        name: k.name,
        active: k.active,
        expiresAt: k.expiresAt?.toISOString() ?? null,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        createdAt: k.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 401 })
  }
}

// POST /api/api-keys — create a new API key
export async function POST(req: NextRequest) {
  try {
    const result = await resolveUser(req)
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status! })
    }
    const body = await req.json()

    // Validate API key creation input
    const parsed = z.object({
      name: z.string().min(1).max(200).default('Default'),
      expiresInDays: z.number().int().positive().max(365 * 10).optional(),
    }).safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const apiKeyResult = await createApiKey(result.user!.id, parsed.data.name, parsed.data.expiresInDays)

    // SOC2: [M-005] Audit API key creation (non-blocking)
    logAudit({
      userId: result.user!.id,
      action: 'api_key_create',
      target: `api_key:${apiKeyResult.info.id}`,
      detail: { name: apiKeyResult.info.name, expiresInDays },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req.headers),
    }).catch(() => {})

    return NextResponse.json({
      key: apiKeyResult.key, // Shown ONCE — can't be retrieved again
      name: apiKeyResult.info.name,
      id: apiKeyResult.info.id,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
