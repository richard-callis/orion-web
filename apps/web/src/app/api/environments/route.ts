import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const environments = await prisma.environment.findMany({
    orderBy: { name: 'asc' },
    include: {
      tools:  { orderBy: { name: 'asc' } },
      agents: { include: { agent: true } },
    },
  })
  // Mask gateway tokens
  return NextResponse.json(environments.map(e => ({ ...e, gatewayToken: e.gatewayToken ? '••••' : null })))
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const VALID_TYPES = ['cluster', 'docker']
  const type = body.type ?? 'cluster'
  if (!VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 })
  }

  const env = await prisma.environment.create({
    data: {
      name:         body.name.trim(),
      type,
      description:  body.description  ?? null,
      gatewayUrl:   body.gatewayUrl   ?? null,
      gatewayToken: body.gatewayToken ?? null,
      giteaOwner:   body.giteaOwner   ?? null,
      giteaRepo:    body.giteaRepo    ?? null,
      policyConfig: body.policyConfig ?? undefined,
      // kubeconfig must be base64-encoded by the client
      kubeconfig:   body.kubeconfig   ?? null,
    },
    include: { tools: true, agents: { include: { agent: true } } },
  })
  return NextResponse.json({ ...env, gatewayToken: env.gatewayToken ? '••••' : null, kubeconfig: env.kubeconfig ? '••••' : null }, { status: 201 })
}
