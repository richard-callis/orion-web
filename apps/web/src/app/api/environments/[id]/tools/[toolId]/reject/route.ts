import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

// POST /api/environments/[id]/tools/[toolId]/reject
export async function POST(req: NextRequest, { params }: { params: { id: string; toolId: string } }) {
  let user: Awaited<ReturnType<typeof requireAdmin>>
  try { user = await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }

  const tool = await prisma.mcpTool.findFirst({ where: { id: params.toolId, environmentId: params.id } })
  if (!tool) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (tool.status !== 'pending') return NextResponse.json({ error: 'Tool is not pending' }, { status: 400 })

  const updated = await prisma.mcpTool.update({
    where: { id: params.toolId },
    data: { status: 'rejected', enabled: false },
  })

  // SOC2: audit tool rejection
  logAudit({
    userId: user.id,
    action: 'tool_revoke',
    target: `tool:${params.toolId}`,
    detail: { environmentId: params.id, toolName: tool.name },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json(updated)
}
