import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export async function GET() {
  await requireAdmin()
  const provider = await prisma.oIDCProvider.findFirst()
  if (!provider) {
    // Return defaults
    return NextResponse.json({
      name: 'Authentik',
      enabled: true,
      headerMode: true,
      issuerUrl: '',
      groupMapping: { 'orion-admins': 'admin', 'orion-users': 'user' },
    })
  }
  return NextResponse.json(provider)
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin()
  const body = await req.json()

  // Validate SSO config fields
  const parsed = z.object({
    name: z.string().max(200).optional(),
    enabled: z.boolean().optional(),
    headerMode: z.boolean().optional(),
    issuerUrl: z.string().max(2000).optional(),
    groupMapping: z.record(z.string().max(200)).max(20).optional(),
  }).safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid SSO configuration' }, { status: 400 })
  }

  const existing = await prisma.oIDCProvider.findFirst()

  if (existing) {
    const updated = await prisma.oIDCProvider.update({
      where: { id: existing.id },
      data: {
        groupMapping: parsed.data.groupMapping ?? existing.groupMapping,
        enabled:      parsed.data.enabled      ?? existing.enabled,
        headerMode:   parsed.data.headerMode   ?? existing.headerMode,
        issuerUrl:    parsed.data.issuerUrl    ?? existing.issuerUrl,
        name:         parsed.data.name         ?? existing.name,
      },
    })

    // SOC2: [M-005] Log SSO config update (non-blocking)
    logAudit({
      userId: admin.id,
      action: 'sso_config_update',
      target: `sso:${existing.id}`,
      detail: { name: parsed.data.name ?? existing.name, enabled: parsed.data.enabled, headerMode: parsed.data.headerMode },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req.headers),
    }).catch(() => {})

    return NextResponse.json(updated)
  }

  // Create initial record
  const created = await prisma.oIDCProvider.create({
    data: {
      name:         parsed.data.name         ?? 'Authentik',
      enabled:      parsed.data.enabled      ?? true,
      headerMode:   parsed.data.headerMode   ?? true,
      issuerUrl:    parsed.data.issuerUrl    ?? '',
      groupMapping: parsed.data.groupMapping ?? { 'orion-admins': 'admin', 'orion-users': 'user' },
    },
  })

  // SOC2: [M-005] Log SSO config creation (non-blocking)
  logAudit({
    userId: admin.id,
    action: 'sso_config_update',
    target: `sso:create`,
    detail: { name: parsed.data.name ?? 'Authentik' },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json(created)
}
