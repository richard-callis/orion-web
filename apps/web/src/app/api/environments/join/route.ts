/**
 * POST /api/environments/join
 * Called by the gateway on first boot with its JOIN_TOKEN.
 * Validates the token, generates a permanent API token, activates the environment.
 * Returns { environmentId, apiToken } — no auth required (token IS the auth).
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { randomBytes } from 'crypto'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { joinToken, gatewayUrl, gatewayType } = body

  if (!joinToken) return NextResponse.json({ error: 'joinToken is required' }, { status: 400 })

  const record = await prisma.environmentJoinToken.findUnique({
    where: { token: joinToken },
    include: { environment: true },
  })

  if (!record)            return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  if (record.usedAt)      return NextResponse.json({ error: 'Token already used' }, { status: 401 })
  if (record.expiresAt < new Date()) return NextResponse.json({ error: 'Token expired' }, { status: 401 })

  // Generate a permanent API token for ongoing communication
  const apiToken = 'mcga_' + randomBytes(32).toString('hex')

  // Mark token as used and update environment in one transaction
  const [, env] = await prisma.$transaction([
    prisma.environmentJoinToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
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

  console.log(`[join] Gateway registered for environment "${env.name}" (${env.id})`)

  return NextResponse.json({
    environmentId: env.id,
    apiToken,
    environmentName: env.name,
  })
}
