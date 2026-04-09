import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { agentId } = await req.json()
  if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 })
  await prisma.agentGroupMember.create({ data: { agentGroupId: params.id, agentId } })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const agentId = req.nextUrl.searchParams.get('agentId')
  if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 })
  await prisma.agentGroupMember.delete({ where: { agentGroupId_agentId: { agentGroupId: params.id, agentId } } })
  return new NextResponse(null, { status: 204 })
}
