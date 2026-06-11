export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

// GET /api/admin/tools — list all MCP tools with environment and agent restriction info
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

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
  let admin
  try { admin = await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const body = await req.json() as { id: string; enabled?: boolean; status?: string }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled
  if (body.status === 'active' || body.status === 'rejected') update.status = body.status

  const tool = await prisma.mcpTool.update({ where: { id: body.id }, data: update })

  // Map operation to nearest AuditAction — detail.operation captures the specifics
  const auditAction = body.status === 'rejected' ? 'tool_revoke' as const : 'tool_approve' as const
  const operation = body.status === 'active' ? 'approve'
    : body.status === 'rejected' ? 'reject'
    : body.enabled === false ? 'disable'
    : 'enable'

  await logAudit({
    userId: admin.id,
    action: auditAction,
    target: `mcpTool:${tool.id}`,
    detail: { toolName: tool.name, operation, enabled: tool.enabled, status: tool.status },
    ipAddress: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip'),
    userAgent: req.headers.get('user-agent'),
  })

  return NextResponse.json(tool)
}
