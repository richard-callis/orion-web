import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { toolGroupId } = await req.json()
  if (!toolGroupId) return NextResponse.json({ error: 'toolGroupId required' }, { status: 400 })
  await prisma.agentGroupToolAccess.create({ data: { agentGroupId: params.id, toolGroupId } })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const toolGroupId = req.nextUrl.searchParams.get('toolGroupId')
  if (!toolGroupId) return NextResponse.json({ error: 'toolGroupId required' }, { status: 400 })
  await prisma.agentGroupToolAccess.delete({ where: { agentGroupId_toolGroupId: { agentGroupId: params.id, toolGroupId } } })
  return new NextResponse(null, { status: 204 })
}
