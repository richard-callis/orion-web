export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// GET /api/admin/tools — list all MCP tools with environment and agent restriction info
export async function GET() {
  const tools = await prisma.mcpTool.findMany({
    orderBy: [{ environmentId: 'asc' }, { name: 'asc' }],
    include: {
      environment: { select: { id: true, name: true } },
      agentRestrictions: {
        include: { agent: { select: { id: true, name: true } } },
      },
    },
  })
  return NextResponse.json(tools)
}

// PATCH /api/admin/tools — update a tool's enabled/status
export async function PATCH(req: NextRequest) {
  const body = await req.json() as { id: string; enabled?: boolean; status?: string }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled
  if (body.status === 'active' || body.status === 'rejected') update.status = body.status

  const tool = await prisma.mcpTool.update({ where: { id: body.id }, data: update })
  return NextResponse.json(tool)
}
