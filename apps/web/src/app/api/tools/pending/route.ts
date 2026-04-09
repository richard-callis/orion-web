export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// GET /api/tools/pending — all pending tool proposals across all environments
export async function GET() {
  const tools = await prisma.mcpTool.findMany({
    where: { status: 'pending' },
    include: { environment: { select: { id: true, name: true } } },
    orderBy: { proposedAt: 'desc' },
  })
  return NextResponse.json(tools)
}
