import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const convo = await prisma.conversation.findUnique({ where: { id: params.id } })
  if (!convo) return new NextResponse(null, { status: 404 })
  return NextResponse.json(convo)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {}
  if ('title'    in body) data.title    = body.title ?? null
  if ('metadata' in body) data.metadata = body.metadata
  const convo = await prisma.conversation.update({
    where: { id: params.id },
    data,
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json(convo)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.conversation.update({
    where: { id: params.id },
    data: { archivedAt: new Date() },
  })
  return new NextResponse(null, { status: 204 })
}
