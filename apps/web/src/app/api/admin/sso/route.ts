import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
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
  const body = await req.json()

  const existing = await prisma.oIDCProvider.findFirst()

  if (existing) {
    const updated = await prisma.oIDCProvider.update({
      where: { id: existing.id },
      data: {
        groupMapping: body.groupMapping ?? existing.groupMapping,
        enabled:      body.enabled      ?? existing.enabled,
        headerMode:   body.headerMode   ?? existing.headerMode,
        issuerUrl:    body.issuerUrl    ?? existing.issuerUrl,
        name:         body.name         ?? existing.name,
      },
    })
    return NextResponse.json(updated)
  }

  // Create initial record
  const created = await prisma.oIDCProvider.create({
    data: {
      name:         body.name         ?? 'Authentik',
      enabled:      body.enabled      ?? true,
      headerMode:   body.headerMode   ?? true,
      issuerUrl:    body.issuerUrl    ?? '',
      groupMapping: body.groupMapping ?? { 'orion-admins': 'admin', 'orion-users': 'user' },
    },
  })
  return NextResponse.json(created)
}
