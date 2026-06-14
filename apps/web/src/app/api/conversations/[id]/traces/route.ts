import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/conversations/[id]/traces — Get trace timeline for a conversation
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const traces = await prisma.agentTrace.findMany({
    where: { conversationId: (await params).id },
    orderBy: { step: 'asc' },
  })
  return NextResponse.json(traces)
}
