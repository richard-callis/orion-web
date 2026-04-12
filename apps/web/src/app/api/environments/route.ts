import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { getDefaultTools } from '@/lib/default-tools'

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

  const VALID_TYPES = ['cluster', 'docker', 'localhost']
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
      gitOwner:     body.gitOwner     ?? null,
      gitRepo:      body.gitRepo      ?? null,
      policyConfig: body.policyConfig ?? undefined,
      kubeconfig:   body.kubeconfig   ?? null,
    },
    include: { tools: true, agents: { include: { agent: true } } },
  })

  // Seed default tools based on environment type
  const defaultTools = getDefaultTools(type)
  if (defaultTools.length > 0) {
    await prisma.mcpTool.createMany({
      data: defaultTools.map(t => ({
        environmentId: env.id,
        name:          t.name,
        description:   t.description,
        inputSchema:   t.inputSchema,
        execType:      t.execType,
        execConfig:    t.execConfig ?? Prisma.JsonNull,
        enabled:       true,
        builtIn:       t.builtIn,
        status:        'active',
      })),
      skipDuplicates: true,
    })
  }

  const envWithTools = await prisma.environment.findUnique({
    where: { id: env.id },
    include: { tools: true, agents: { include: { agent: true } } },
  })

  return NextResponse.json(
    { ...envWithTools, gatewayToken: envWithTools?.gatewayToken ? '••••' : null, kubeconfig: envWithTools?.kubeconfig ? '••••' : null },
    { status: 201 }
  )
}
