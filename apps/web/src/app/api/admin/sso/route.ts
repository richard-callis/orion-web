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
    groupMapping: z.record(z.string().max(200)).refine(
      (val) => Object.keys(val).length <= 20,
      { message: 'Maximum 20 group mappings allowed' }
    ).optional(),
  }).safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid SSO configuration' }, { status: 400 })
  }

  const existing = await prisma.oIDCProvider.findFirst()

  if (existing) {
    const updateData: any = {}
    if (parsed.data.groupMapping !== undefined) updateData.groupMapping = parsed.data.groupMapping
    if (parsed.data.enabled !== undefined) updateData.enabled = parsed.data.enabled
    if (parsed.data.headerMode !== undefined) updateData.headerMode = parsed.data.headerMode
    if (parsed.data.issuerUrl !== undefined) updateData.issuerUrl = parsed.data.issuerUrl
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name

    const updated = await prisma.oIDCProvider.update({
      where: { id: existing.id },
      data: updateData,
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
