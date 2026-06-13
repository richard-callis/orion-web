import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser, requireGatewayAuthForEnvironment } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // Support gateway Bearer auth OR admin session auth
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) {
    // Gateway path: validate the token is scoped to this specific environment
    try {
      await requireGatewayAuthForEnvironment(req, params.id)
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else {
    // Session path: require admin (consistent with all other environments/[id]/* sub-routes)
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // SOC2 HIGH-6: verify the caller is admin — environments are admin-scoped resources
    if (user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // Verify environment exists
  const env = await prisma.environment.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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
  // SOC2 HIGH-6: require admin for session callers (consistent with other env sub-routes)
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

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
