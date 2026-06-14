import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// POST — add a tool to the group
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { toolId } = await req.json()
  if (!toolId || typeof toolId !== 'string' || !toolId.trim()) {
    return NextResponse.json({ error: 'toolId is required' }, { status: 400 })
  }
  const toolExists = await prisma.mcpTool.findUnique({ where: { id: toolId }, select: { id: true } })
  if (!toolExists) return NextResponse.json({ error: 'Tool not found' }, { status: 404 })
  await prisma.toolGroupTool.create({ data: { toolGroupId: (await params).id, toolId } })
  return NextResponse.json({ ok: true })
}

// DELETE — remove a tool from the group (?toolId=xxx)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const toolId = req.nextUrl.searchParams.get('toolId')
  if (!toolId) return NextResponse.json({ error: 'toolId required' }, { status: 400 })
  await prisma.toolGroupTool.delete({ where: { toolGroupId_toolId: { toolGroupId: (await params).id, toolId } } })
  return new NextResponse(null, { status: 204 })
}
