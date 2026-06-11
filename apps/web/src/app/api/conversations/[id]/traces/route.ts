import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/conversations/[id]/traces — Get trace timeline for a conversation
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const traces = await prisma.agentTrace.findMany({
    where: { conversationId: params.id },
    orderBy: { step: 'asc' },
  })
  return NextResponse.json(traces)
}
