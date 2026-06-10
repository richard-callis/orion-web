import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  await requireAdmin()
  let parsed: unknown
  try { parsed = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const { agentId } = parsed as { agentId?: string }
  if (!agentId || typeof agentId !== 'string' || !agentId.trim()) {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
  }
  const agentExists = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } })
  if (!agentExists) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  await prisma.agentGroupMember.create({ data: { agentGroupId: params.id, agentId } })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  await requireAdmin()
  const agentId = req.nextUrl.searchParams.get('agentId')
  if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 })
  await prisma.agentGroupMember.delete({ where: { agentGroupId_agentId: { agentGroupId: params.id, agentId } } })
  return new NextResponse(null, { status: 204 })
}
