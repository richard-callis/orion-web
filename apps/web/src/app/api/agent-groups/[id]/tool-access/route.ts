import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  let parsed: unknown
  try { parsed = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const { toolGroupId } = parsed as { toolGroupId?: string }
  if (!toolGroupId) return NextResponse.json({ error: 'toolGroupId required' }, { status: 400 })
  await prisma.agentGroupToolAccess.create({ data: { agentGroupId: (await params).id, toolGroupId } })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  const toolGroupId = req.nextUrl.searchParams.get('toolGroupId')
  if (!toolGroupId) return NextResponse.json({ error: 'toolGroupId required' }, { status: 400 })
  await prisma.agentGroupToolAccess.delete({ where: { agentGroupId_toolGroupId: { agentGroupId: (await params).id, toolGroupId } } })
  return new NextResponse(null, { status: 204 })
}
