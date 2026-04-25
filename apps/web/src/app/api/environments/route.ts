import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { getDefaultTools } from '@/lib/default-tools'
import { getCurrentUser, requireAdmin } from '@/lib/auth'
import { CreateEnvironmentSchema } from '@/lib/validate'

export async function GET() {
  // SOC2: CR-002 — require authentication to list environments
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const environments = await prisma.environment.findMany({
    orderBy: { name: 'asc' },
    include: {
      tools:  { orderBy: { name: 'asc' } },
      agents: { include: { agent: true } },
    },
  })
  // Mask sensitive fields
  return NextResponse.json(environments.map(e => ({ ...e, gatewayToken: e.gatewayToken ? '••••' : null, kubeconfig: e.kubeconfig ? '••••' : null })))
}

export async function POST(req: NextRequest) {
  // SOC2: CR-002 — require admin to create environments
  const user = await requireAdmin()

  // SOC2: Input validation — validate and sanitize all request body fields
  const rawBody = await req.json().catch(() => ({}))
  const body = typeof rawBody === 'object' && rawBody !== null ? rawBody : {}

  const parsed = CreateEnvironmentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })) },
      { status: 400 },
    )
  }

  const env = await prisma.environment.create({
    data: {
      name:         parsed.data.name,
      type:         parsed.data.type,
      description:  parsed.data.description ?? null,
      gatewayUrl:   parsed.data.gatewayUrl ?? null,
      gatewayToken: parsed.data.gatewayToken ?? null,
      gitOwner:     parsed.data.gitOwner ?? null,
      gitRepo:      parsed.data.gitRepo ?? null,
      policyConfig: parsed.data.policyConfig,
      kubeconfig:   parsed.data.kubeconfig ?? null,
      metadata:     parsed.data.metadata,
    },
    include: { tools: true, agents: { include: { agent: true } } },
  })

  // Seed default tools based on environment type
  const defaultTools = getDefaultTools(parsed.data.type)
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
