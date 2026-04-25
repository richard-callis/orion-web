import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const env = await prisma.environment.findUnique({
    where: { id: params.id },
    include: {
      tools:     { orderBy: { name: 'asc' } },
      agents:    { include: { agent: true } },
      gitOpsPRs: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({
    ...env,
    gatewayToken: env.gatewayToken ? '••••' : null,
    kubeconfig:   env.kubeconfig   ? '••••' : null,
  })
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = req.headers.get('authorization')
  const body = await req.json()
  const data: Record<string, unknown> = {}

  if (auth?.startsWith('Bearer ')) {
    // ── Gateway heartbeat / register ──────────────────────────────────
    // Validate the token against the stored gateway token for this environment.
    const env = await prisma.environment.findUnique({
      where: { id: params.id },
      select: { gatewayToken: true },
    })
    if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!env.gatewayToken || auth !== `Bearer ${env.gatewayToken}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // Gateways may only update heartbeat fields — not name, kubeconfig, policy, etc.
    if (body.status         !== undefined) data.status         = body.status
    if (body.lastSeen       !== undefined) data.lastSeen       = body.lastSeen ? new Date(body.lastSeen) : null
    if (body.gatewayUrl     !== undefined) data.gatewayUrl     = body.gatewayUrl  || null
    if (body.gatewayVersion !== undefined) data.gatewayVersion = body.gatewayVersion || null
  } else {
    // ── Browser / admin UI ─────────────────────────────────────────────
    const admin = await requireAdmin()
    if (body.name        !== undefined) data.name        = body.name.trim()
    if (body.type        !== undefined) data.type        = body.type
    if (body.description !== undefined) data.description = body.description || null
    if (body.gatewayUrl  !== undefined) data.gatewayUrl  = body.gatewayUrl  || null
    if (body.gatewayToken !== undefined && body.gatewayToken !== '••••') {
      data.gatewayToken = body.gatewayToken || null
    }
    if (body.status         !== undefined) data.status         = body.status
    if (body.lastSeen       !== undefined) data.lastSeen       = body.lastSeen ? new Date(body.lastSeen) : null
    if (body.gatewayVersion !== undefined) data.gatewayVersion = body.gatewayVersion || null
    if (body.metadata     !== undefined) data.metadata     = body.metadata
    if (body.gitOwner     !== undefined) data.gitOwner     = body.gitOwner     || null
    if (body.gitRepo      !== undefined) data.gitRepo      = body.gitRepo      || null
    if (body.argoCdUrl    !== undefined) data.argoCdUrl    = body.argoCdUrl    || null
    if (body.policyConfig !== undefined) data.policyConfig = body.policyConfig
    if (body.kubeconfig   !== undefined && body.kubeconfig !== '••••') {
      data.kubeconfig = body.kubeconfig || null
    }

    const env = await prisma.environment.update({
      where: { id: params.id },
      data,
      include: {
        tools:     { orderBy: { name: 'asc' } },
        agents:    { include: { agent: true } },
        gitOpsPRs: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    })

    // SOC2: [M-005] Log environment update (non-blocking)
    logAudit({
      userId: admin.id,
      action: 'environment_update',
      target: `environment:${params.id}`,
      detail: { name: body.name ?? env.name, changes: Object.keys(data) },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req.headers),
    }).catch(() => {})

    return NextResponse.json({
      ...env,
      gatewayToken: env.gatewayToken ? '••••' : null,
      kubeconfig:   env.kubeconfig   ? '••••' : null,
    })
  }

  // Gateway heartbeat path — return updated env without audit log
  const env = await prisma.environment.update({
    where: { id: params.id },
    data,
    include: {
      tools:     { orderBy: { name: 'asc' } },
      agents:    { include: { agent: true } },
      gitOpsPRs: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  })
  return NextResponse.json({
    ...env,
    gatewayToken: env.gatewayToken ? '••••' : null,
    kubeconfig:   env.kubeconfig   ? '••••' : null,
  })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await requireAdmin()
  const env = await prisma.environment.findUnique({
    where: { id: params.id },
    select: { name: true },
  })
  await prisma.environment.delete({ where: { id: params.id } })

  // SOC2: [M-005] Log environment deletion (non-blocking)
  logAudit({
    userId: admin.id,
    action: 'environment_delete',
    target: `environment:${params.id}`,
    detail: { name: env?.name },
    ipAddress: getClientIp(_req),
    userAgent: getUserAgent(_req.headers),
  }).catch(() => {})

  return new NextResponse(null, { status: 204 })
}
