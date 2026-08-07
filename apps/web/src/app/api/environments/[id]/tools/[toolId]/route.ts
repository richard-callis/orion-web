import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { sanitizeCommand } from '@/lib/sanitize-command'

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string; toolId: string }> }) {
  // Support gateway Bearer token OR user session
  const auth = _.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) {
    const env = await prisma.environment.findUnique({
      where: { id: (await params).id },
      select: { gatewayToken: true },
    })
    if (!env?.gatewayToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (auth !== `Bearer ${env.gatewayToken}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  } else {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tool = await prisma.mcpTool.findFirst({ where: { id: (await params).toolId, environmentId: (await params).id } })
  if (!tool) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(tool)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; toolId: string }> }) {
  // SOC2: CR-001 — require authenticated user
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // SOC2 HIGH-6: verify the caller is admin — environments/tools are admin-scoped resources
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  // Verify env exists
  const { id, toolId } = await params
  const env = await prisma.environment.findUnique({ where: { id }, select: { id: true, type: true } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Verify the tool actually belongs to this environment before mutating it
  const existing = await prisma.mcpTool.findFirst({ where: { id: toolId, environmentId: id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const data: Record<string, unknown> = {}

  if (body.name        !== undefined) data.name        = body.name.trim()
  if (body.description !== undefined) data.description = body.description.trim()
  if (body.inputSchema !== undefined) data.inputSchema = body.inputSchema
  if (body.execType    !== undefined) data.execType    = body.execType
  if (body.execConfig  !== undefined) data.execConfig  = body.execConfig || null
  if (body.enabled     !== undefined) data.enabled     = body.enabled

  // SOC2: this route mutates an already-active tool's execConfig directly — sanitize any shell
  // command the same way generate/approve/create do, so a rewritten command can't skip validation.
  if (data.execConfig && typeof data.execConfig === 'object' && 'command' in (data.execConfig as Record<string, unknown>)) {
    try {
      const cfg = data.execConfig as Record<string, unknown>
      data.execConfig = { ...cfg, command: sanitizeCommand(String(cfg.command), env.type) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: `Invalid execConfig.command: ${msg}` }, { status: 400 })
    }
  }

  const tool = await prisma.mcpTool.update({
    where: { id: toolId },
    data,
  })
  return NextResponse.json(tool)
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string; toolId: string }> }) {
  // SOC2: CR-001 — require authenticated user
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // SOC2 HIGH-6: verify the caller is admin — environments/tools are admin-scoped resources
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id, toolId } = await params
  const existing = await prisma.mcpTool.findFirst({ where: { id: toolId, environmentId: id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await prisma.mcpTool.delete({ where: { id: toolId } })
  return new NextResponse(null, { status: 204 })
}
