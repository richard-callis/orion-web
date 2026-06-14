import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { assertConversationOwner } from '@/lib/conversation-owner'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // B1 fix: this route had no auth at all — any caller could read any conversation's messages
  const check = await assertConversationOwner(req, (await params).id)
  if (check instanceof NextResponse) return check

  const messages = await prisma.message.findMany({
    where: { conversationId: (await params).id },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json(messages)
}
