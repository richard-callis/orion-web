import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/conversations/[id]/traces — Get trace timeline for a conversation
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const traces = await prisma.agentTrace.findMany({
    where: { conversationId: params.id },
    orderBy: { step: 'asc' },
  })
  return NextResponse.json(traces)
}
