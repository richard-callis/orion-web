import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export async function GET(_: NextRequest, { params }: { params: { id: string; toolId: string } }) {
  // Support gateway Bearer token OR user session
  const auth = _.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) {
    const env = await prisma.environment.findUnique({
      where: { id: params.id },
      select: { gatewayToken: true },
    })
    if (!env?.gatewayToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (auth !== `Bearer ${env.gatewayToken}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  } else {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tool = await prisma.mcpTool.findFirst({ where: { id: params.toolId, environmentId: params.id } })
  if (!tool) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(tool)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string; toolId: string } }) {
  // SOC2: CR-001 — require authenticated user
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Verify env exists
  const env = await prisma.environment.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const data: Record<string, unknown> = {}

  if (body.name        !== undefined) data.name        = body.name.trim()
  if (body.description !== undefined) data.description = body.description.trim()
  if (body.inputSchema !== undefined) data.inputSchema = body.inputSchema
  if (body.execType    !== undefined) data.execType    = body.execType
  if (body.execConfig  !== undefined) data.execConfig  = body.execConfig || null
  if (body.enabled     !== undefined) data.enabled     = body.enabled

  const tool = await prisma.mcpTool.update({
    where: { id: params.toolId },
    data,
  })
  return NextResponse.json(tool)
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string; toolId: string } }) {
  // SOC2: CR-001 — require authenticated user
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await prisma.mcpTool.delete({ where: { id: params.toolId } })
  return new NextResponse(null, { status: 204 })
}
