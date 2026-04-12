import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

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
  const body = await req.json()
  const data: Record<string, unknown> = {}

  if (body.name        !== undefined) data.name        = body.name.trim()
  if (body.type        !== undefined) data.type        = body.type
  if (body.description !== undefined) data.description = body.description || null
  if (body.gatewayUrl  !== undefined) data.gatewayUrl  = body.gatewayUrl  || null
  // Only update token if explicitly provided (not the masked value)
  if (body.gatewayToken !== undefined && body.gatewayToken !== '••••') {
    data.gatewayToken = body.gatewayToken || null
  }
  if (body.status       !== undefined) data.status       = body.status
  if (body.lastSeen     !== undefined) data.lastSeen     = body.lastSeen ? new Date(body.lastSeen) : null
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
  return NextResponse.json({
    ...env,
    gatewayToken: env.gatewayToken ? '••••' : null,
    kubeconfig:   env.kubeconfig   ? '••••' : null,
  })
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  await prisma.environment.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
