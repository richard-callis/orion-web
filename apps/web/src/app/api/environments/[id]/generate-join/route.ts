import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { randomBytes } from 'crypto'

// Allowed gateway types — caller-supplied type is validated against this list
// to prevent type confusion (e.g. forging localhost type to trigger Docker-socket paths)
const ALLOWED_GATEWAY_TYPES = new Set(['cluster', 'docker', 'localhost'])

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // B3 fix: generate-join previously had no auth — BEARER_PATHS only checked that
  // the Authorization header started with 'Bearer', not that it was a valid token.
  // Any caller could mint a join token for any environment. Require admin session.
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Burn any unused tokens for this environment first (only one active at a time)
  await prisma.environmentJoinToken.deleteMany({
    where: { environmentId: params.id, usedAt: null },
  })

  const token = 'mcg_' + randomBytes(24).toString('hex')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h

  await prisma.environmentJoinToken.create({
    data: { token, environmentId: params.id, expiresAt },
  })

  const body = await req.json().catch(() => ({}))
  const gatewayUrl: string = body.gatewayUrl ?? ''
  const requestedType: string = body.gatewayType ?? env.type ?? 'cluster'
  // M2 fix: validate gatewayType against allowlist to prevent type confusion
  const gatewayType: string = ALLOWED_GATEWAY_TYPES.has(requestedType) ? requestedType : 'cluster'

  // Public URL — prefer the request Host header, but it may be 0.0.0.0 inside Docker.
  // Use x-forwarded-host (set by Traefik) when available, then MANAGEMENT_IP, then request host.
  const reqUrl = new URL(req.url)
  const forwardedHost = req.headers.get('x-forwarded-host')
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? reqUrl.protocol.replace(':', '')
  const managementIp = process.env.MANAGEMENT_IP
  const orionPublicUrl = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : managementIp
    ? `http://${managementIp}:3000`
    : `${reqUrl.protocol}//${reqUrl.host}`

  // Callback URL — what gateways and cluster nodes use to reach ORION (bypasses Cloudflare/proxies).
  const orionCallbackUrl = (process.env.ORION_CALLBACK_URL ?? orionPublicUrl).replace(/\/$/, '')

  const dockerCmd = [
    'docker run -d \\',
    `  -e JOIN_TOKEN=${token} \\`,
    `  -e GATEWAY_TYPE=${gatewayType} \\`,
    gatewayUrl ? `  -e GATEWAY_URL=${gatewayUrl} \\` : null,
    `  -e ORION_URL=${orionCallbackUrl} \\`,
    `  --restart unless-stopped \\`,
    `  ghcr.io/richard-callis/orion-gateway:latest`,
  ].filter(Boolean).join('\n')

  // Use the callback URL so the manifest curl works from cluster nodes (not blocked by Cloudflare)
  const kubectlCmd = `kubectl apply -f <(curl -s '${orionCallbackUrl}/api/environments/join/${token}/manifest?type=${gatewayType}')`

  return NextResponse.json({ token, expiresAt, dockerCmd, kubectlCmd, orionUrl: orionPublicUrl })
}
