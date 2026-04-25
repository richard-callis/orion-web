import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

async function verifyEnvAccess(userId: string, envId: string): Promise<{ error: NextResponse['body']; env: { id: string } } | null> {
  const env = await prisma.environment.findUnique({ where: { id: envId }, select: { id: true } })
  if (!env) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }).body, env: {} as any }
  return null // access OK (any authenticated user can list/manage tools on any env for now)
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // Support gateway Bearer auth (existing) OR user session auth (SOC2: CR-001)
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) {
    const env = await prisma.environment.findUnique({
      where: { id: params.id },
      select: { gatewayToken: true },
    })
    if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!env.gatewayToken || auth !== `Bearer ${env.gatewayToken}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const enabledOnly = searchParams.get('enabled') === 'true'

  const tools = await prisma.mcpTool.findMany({
    where: {
      environmentId: params.id,
      ...(enabledOnly ? { enabled: true, status: 'active' } : {}),
    },
    orderBy: [{ builtIn: 'desc' }, { name: 'asc' }],
  })
  return NextResponse.json(tools)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // SOC2: CR-001 — require authenticated user
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Verify env exists
  const env = await prisma.environment.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()

  if (!body.name?.trim())        return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (!body.description?.trim()) return NextResponse.json({ error: 'description is required' }, { status: 400 })
  if (!body.inputSchema)         return NextResponse.json({ error: 'inputSchema is required' }, { status: 400 })

  const VALID_EXEC_TYPES = ['builtin', 'shell', 'http']
  const execType = body.execType ?? 'shell'
  if (!VALID_EXEC_TYPES.includes(execType)) {
    return NextResponse.json({ error: `execType must be one of: ${VALID_EXEC_TYPES.join(', ')}` }, { status: 400 })
  }

  const tool = await prisma.mcpTool.create({
    data: {
      environmentId: params.id,
      name:          body.name.trim(),
      description:   body.description.trim(),
      inputSchema:   body.inputSchema,
      execType,
      execConfig:    body.execConfig ?? null,
      enabled:       body.enabled ?? true,
      builtIn:       false,
    },
  })
  return NextResponse.json(tool, { status: 201 })
}
