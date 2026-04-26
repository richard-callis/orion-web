import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { parseBodyOrError, UpdateConversationSchema } from '@/lib/validate'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const convo = await prisma.conversation.findUnique({ where: { id: params.id } })
  if (!convo) return new NextResponse(null, { status: 404 })
  return NextResponse.json(convo)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, UpdateConversationSchema)
  if ('error' in result) return result.error
  const { data } = result

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {}
  if (data.title    !== undefined) updateData.title    = data.title ?? null
  if (data.metadata !== undefined) updateData.metadata = data.metadata
  const convo = await prisma.conversation.update({
    where: { id: params.id },
    data: updateData,
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
