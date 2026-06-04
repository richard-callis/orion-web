import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { assertConversationOwner } from '@/lib/conversation-owner'
import { parseBodyOrError, UpdateConversationSchema } from '@/lib/validate'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const check = await assertConversationOwner(req, params.id)
  if (check instanceof NextResponse) return check
  const convo = await prisma.conversation.findUnique({ where: { id: params.id } })
  if (!convo) return new NextResponse(null, { status: 404 })
  return NextResponse.json(convo)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const check = await assertConversationOwner(req, params.id)
  if (check instanceof NextResponse) return check

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, UpdateConversationSchema)
  if ('error' in result) return result.error
  const { data } = result

  const existingMeta = check.conversation.metadata as Record<string, unknown> | null ?? {}
  const ownerId = existingMeta.ownerId  // preserve — never let caller overwrite

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {}
  if (data.title !== undefined) updateData.title = data.title ?? null
  if (data.metadata !== undefined) {
    // M2 fix: merge metadata, protecting ownerId from being overwritten
    updateData.metadata = { ...existingMeta, ...data.metadata, ownerId }
  }

  const convo = await prisma.conversation.update({
    where: { id: params.id },
    data: updateData,
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json(convo)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const check = await assertConversationOwner(req, params.id)
  if (check instanceof NextResponse) return check
  await prisma.conversation.update({
    where: { id: params.id },
    data: { archivedAt: new Date() },
  })
  return new NextResponse(null, { status: 204 })
}
