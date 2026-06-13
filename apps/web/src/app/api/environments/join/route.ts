/**
 * POST /api/environments/join
 * Called by the gateway on first boot with its JOIN_TOKEN.
 * Validates the token, generates a permanent API token, activates the environment.
 * Returns { environmentId, apiToken } — no auth required (token IS the auth).
 *
 * Security model:
 * - First join:   token is one-time; gateway sends a machineId (stable UUID persisted on disk).
 *                 ORION stores SHA-256(machineId) as a fingerprint on the join token record.
 * - Re-join:      token already used → ORION verifies fingerprint matches before returning
 *                 existing credentials. A stolen token without the original machineId is rejected.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { randomBytes, createHash } from 'crypto'
import { logAudit } from '@/lib/audit'

function hashFingerprint(machineId: string): string {
  return createHash('sha256').update(machineId).digest('hex')
}

export async function POST(req: NextRequest) {
  const body = await req.json()

  // Validate join token is present and non-empty
  if (!body?.joinToken || typeof body.joinToken !== 'string' || body.joinToken.trim().length === 0) {
    return NextResponse.json({ error: 'joinToken is required' }, { status: 400 })
  }

  // Validate optional fields have correct types
  const parsed = z.object({
    joinToken: z.string().min(1),
    gatewayType: z.enum(['cluster', 'docker', 'localhost']).optional(),
    machineId: z.string().max(100).optional(),
    gatewayUrl: z.string().max(2000).optional(),
  }).safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const { joinToken, gatewayType, machineId, gatewayUrl: parsedGatewayUrl } = parsed.data

  // Ensure gatewayUrl always has a protocol so fetch() works
  const rawUrl: string | undefined = parsed.data.gatewayUrl
  const gatewayUrl = rawUrl && !rawUrl.startsWith('http') ? `http://${rawUrl}` : rawUrl

  // Dual lookup: try SHA-256 hash first (new tokens), fall back to plaintext
  // (tokens created before hashing was introduced). Drop plaintext fallback once
  // all existing tokens expire (24h max lifetime).
  const tokenHash = createHash('sha256').update(joinToken).digest('hex')
  const record = await prisma.environmentJoinToken.findUnique({
    where: { token: tokenHash },
    include: { environment: true },
  }) ?? await prisma.environmentJoinToken.findUnique({
    where: { token: joinToken },
    include: { environment: true },
  })

  if (!record)                        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  if (record.expiresAt < new Date())  return NextResponse.json({ error: 'Token expired' }, { status: 401 })

  // ── SSRF guard — validate gatewayUrl before persisting ─────────────────────
  if (body.gatewayUrl) {
    const { isPrivateUrl } = await import('@/lib/ssrf-guard')
    if (await isPrivateUrl(body.gatewayUrl)) {
      return NextResponse.json({ error: 'Invalid gateway URL' }, { status: 400 })
    }
  }

  // ── Idempotent re-join ──────────────────────────────────────────────────────
  // If the token was already used (e.g. gateway restarted before saving credentials),
  // return the existing credentials — but only if the fingerprint matches.
  if (record.usedAt) {
    const env = await prisma.environment.findUnique({ where: { id: record.environmentId } })
    if (!env?.gatewayToken) {
      return NextResponse.json({ error: 'Token already used and no credentials found' }, { status: 401 })
    }

    // Verify fingerprint if one was recorded at first join
    if (record.fingerprint) {
      if (!machineId) {
        console.warn(`[join] Re-join rejected for "${env.name}": fingerprint required but machineId not provided`)
        return NextResponse.json({ error: 'Fingerprint required for re-join' }, { status: 401 })
      }
      const presented = hashFingerprint(machineId)
      if (presented !== record.fingerprint) {
        console.warn(`[join] Re-join REJECTED for "${env.name}": fingerprint mismatch (possible token theft)`)
        return NextResponse.json({ error: 'Fingerprint mismatch' }, { status: 401 })
      }
    }

    console.log(`[join] Idempotent re-join for environment "${env.name}" (${env.id})`)
    await prisma.environment.update({
      where: { id: env.id },
      data: { status: 'connected', lastSeen: new Date(), gatewayUrl: gatewayUrl ?? env.gatewayUrl },
    })
    void logAudit({
      userId: 'system',
      action: 'environment_update',
      target: `environment:${env.id}`,
      detail: { event: 'gateway_joined', environmentId: env.id, gatewayType: body.gatewayType ?? 'unknown' },
    })
    return NextResponse.json({ environmentId: env.id, apiToken: env.gatewayToken, environmentName: env.name })
  }

  // ── First join ─────────────────────────────────────────────────────────────
  const apiToken    = 'mcga_' + randomBytes(32).toString('hex')
  const fingerprint = machineId ? hashFingerprint(machineId) : null

  const [tokenUpdate, env] = await prisma.$transaction([
    prisma.environmentJoinToken.updateMany({
      where: { id: record.id, usedAt: null },  // conditional: only if not yet used
      data: { usedAt: new Date(), fingerprint },
    }),
    prisma.environment.update({
      where: { id: record.environmentId },
      data: {
        status:       'connected',
        gatewayToken: apiToken,
        gatewayUrl:   gatewayUrl ?? record.environment.gatewayUrl,
        type:         gatewayType ?? record.environment.type,
        lastSeen:     new Date(),
      },
    }),
  ])
  if (tokenUpdate.count === 0) {
    // Another concurrent request already consumed this token
    return NextResponse.json({ error: 'Join token already used' }, { status: 409 })
  }

  console.log(`[join] Gateway registered for environment "${env.name}" (${env.id})${fingerprint ? ' with fingerprint' : ' (no fingerprint)'}`)

  void logAudit({
    userId: 'system',
    action: 'environment_update',
    target: `environment:${env.id}`,
    detail: { event: 'gateway_joined', environmentId: env.id, gatewayType: body.gatewayType ?? 'unknown' },
  })

  return NextResponse.json({
    environmentId: env.id,
    apiToken,
    environmentName: env.name,
  })
}
