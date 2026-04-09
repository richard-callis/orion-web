import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
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
