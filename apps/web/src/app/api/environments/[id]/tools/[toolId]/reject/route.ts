import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// POST /api/environments/[id]/tools/[toolId]/reject
export async function POST(_: NextRequest, { params }: { params: { id: string; toolId: string } }) {
  const tool = await prisma.mcpTool.findFirst({ where: { id: params.toolId, environmentId: params.id } })
  if (!tool) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (tool.status !== 'pending') return NextResponse.json({ error: 'Tool is not pending' }, { status: 400 })

  const updated = await prisma.mcpTool.update({
    where: { id: params.toolId },
    data: { status: 'rejected', enabled: false },
  })
  return NextResponse.json(updated)
}
