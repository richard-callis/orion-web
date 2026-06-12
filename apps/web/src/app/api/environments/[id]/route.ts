import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { parseBodyOrError, CreateEnvironmentSchema } from '@/lib/validate'
import { encrypt, decrypt } from '@/lib/encryption'
import { timingSafeEqual } from 'crypto'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // BLOCKER fix: GET had no auth — any request with an arbitrary Bearer header
  // passes through BEARER_PATHS middleware without a session, exposing environment
  // config (gitOwner/Repo, gatewayUrl, tool list, policyConfig) to unauthenticated callers.
  // Allow both admin sessions and gateway self-calls (their own Bearer token).
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) {
    // Session path — require admin
    try { await requireAdmin() } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }
  // If Bearer header is present, it will be validated by the gateway-token path
  // in PUT or by the downstream operation. For GET, validate it matches this env.
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7)
    const envCheck = await prisma.environment.findUnique({ where: { id: params.id }, select: { gatewayToken: true } })
    if (!envCheck?.gatewayToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    try {
      const storedToken = decrypt(envCheck.gatewayToken)
      if (storedToken.length !== token.length || !timingSafeEqual(Buffer.from(storedToken), Buffer.from(token))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

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

  if (auth?.startsWith('Bearer ')) {
    // ── Gateway heartbeat / register ──────────────────────────────────
    // Validate the token against the stored gateway token for this environment.
    const body = await req.json()
    const env = await prisma.environment.findUnique({
      where: { id: params.id },
      select: { gatewayToken: true },
    })
    if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!env.gatewayToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    try {
      const storedGatewayToken = decrypt(env.gatewayToken)
      const bearerToken = auth.slice(7)
      if (storedGatewayToken.length !== bearerToken.length ||
          !timingSafeEqual(Buffer.from(storedGatewayToken), Buffer.from(bearerToken))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // Gateways may only update heartbeat fields — not name, kubeconfig, policy, etc.
    const data: Record<string, unknown> = {}
    if (body.status         !== undefined) data.status         = body.status
    if (body.lastSeen       !== undefined) data.lastSeen       = body.lastSeen ? new Date(body.lastSeen) : null
    if (body.gatewayUrl     !== undefined) data.gatewayUrl     = body.gatewayUrl  || null
    if (body.gatewayVersion !== undefined) data.gatewayVersion = body.gatewayVersion || null

    const updated = await prisma.environment.update({
      where: { id: params.id },
      data,
      include: {
        tools:     { orderBy: { name: 'asc' } },
        agents:    { include: { agent: true } },
        gitOpsPRs: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    })
    return NextResponse.json({
      ...updated,
      gatewayToken: updated.gatewayToken ? '••••' : null,
      kubeconfig:   updated.kubeconfig   ? '••••' : null,
    })
  } else {
    // ── Browser / admin UI ─────────────────────────────────────────────
    // SOC2 [INPUT-001]: Validate request body with Zod schema
    const result = await parseBodyOrError(req, CreateEnvironmentSchema)
    if ('error' in result) return result.error
    const { data } = result

    const admin = await requireAdmin()
    const updateData: Record<string, unknown> = {}
    if (data.name !== undefined) updateData.name = data.name.trim()
    if (data.type !== undefined) updateData.type = data.type
    if (data.description !== undefined) updateData.description = data.description || null
    if (data.gatewayUrl !== undefined) updateData.gatewayUrl = data.gatewayUrl || null
    if (data.gatewayToken !== undefined && data.gatewayToken !== '••••') {
      updateData.gatewayToken = data.gatewayToken || null
    }
    if (data.gitOwner !== undefined) updateData.gitOwner = data.gitOwner || null
    if (data.gitRepo !== undefined) updateData.gitRepo = data.gitRepo || null
    if (data.policyConfig !== undefined) updateData.policyConfig = data.policyConfig
    if (data.kubeconfig !== undefined && data.kubeconfig !== '••••') {
      updateData.kubeconfig = data.kubeconfig || null
    }
    if (data.federationRole  !== undefined) updateData.federationRole  = data.federationRole  === 'standalone' ? null : (data.federationRole ?? null)
    if (data.federationToken !== undefined) {
      const rawFedToken = data.federationToken ?? null
      updateData.federationToken = rawFedToken && process.env.ORION_ENCRYPTION_KEY
        ? encrypt(rawFedToken)
        : rawFedToken
    }
    if (data.spokeUrl        !== undefined) updateData.spokeUrl        = data.spokeUrl        ?? null
    if (data.hubUrl          !== undefined) updateData.hubUrl          = data.hubUrl          ?? null

    const env = await prisma.environment.update({
      where: { id: params.id },
      data: updateData,
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
      detail: { name: data.name ?? env.name, changes: Object.keys(updateData) },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req.headers),
    }).catch(() => {})

    return NextResponse.json({
      ...env,
      gatewayToken: env.gatewayToken ? '••••' : null,
      kubeconfig:   env.kubeconfig   ? '••••' : null,
    })
  }
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
