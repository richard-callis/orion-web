import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// POST — add a tool to the group
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { toolId } = await req.json()
  if (!toolId) return NextResponse.json({ error: 'toolId required' }, { status: 400 })
  await prisma.toolGroupTool.create({ data: { toolGroupId: params.id, toolId } })
  return NextResponse.json({ ok: true })
}

// DELETE — remove a tool from the group (?toolId=xxx)
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const toolId = req.nextUrl.searchParams.get('toolId')
  if (!toolId) return NextResponse.json({ error: 'toolId required' }, { status: 400 })
  await prisma.toolGroupTool.delete({ where: { toolGroupId_toolId: { toolGroupId: params.id, toolId } } })
  return new NextResponse(null, { status: 204 })
}
