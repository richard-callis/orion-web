import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

// POST /api/environments/[id]/tools/[toolId]/approve
// Approves a pending tool proposal — activates it so the gateway picks it up on next heartbeat.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; toolId: string }> }) {
  // SOC2: CR-001 — require admin to approve tools (prevents unauthorized tool activation)
  const user = await requireAdmin()

  // Verify env exists
  const env = await prisma.environment.findUnique({ where: { id: (await params).id }, select: { id: true } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const tool = await prisma.mcpTool.findFirst({ where: { id: (await params).toolId, environmentId: (await params).id } })
  if (!tool) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (tool.status !== 'pending') return NextResponse.json({ error: 'Tool is not pending' }, { status: 400 })
  // SOC2: separation of duties — prevent self-approval.
  // proposedBy stores the userId when the tool was submitted by a human admin.
  if (tool.proposedBy === user.id) {
    return NextResponse.json({ error: 'Cannot approve your own tool request' }, { status: 403 })
  }

  // Allow the human to update the command before approving
  const body = await req.json().catch(() => ({}))

  const updated = await prisma.mcpTool.update({
    where: { id: (await params).toolId },
    data: {
      status:  'active',
      enabled: body.enabled !== false,
      ...(body.description !== undefined && { description: body.description }),
      ...(body.execConfig  !== undefined && { execConfig:  body.execConfig }),
      ...(body.inputSchema !== undefined && { inputSchema: body.inputSchema }),
    },
  })
  // SOC2: audit tool approval (activates gateway tool)
  logAudit({
    userId: user.id,
    action: 'tool_approve',
    target: `tool:${(await params).toolId}`,
    detail: { environmentId: (await params).id, toolName: tool.name },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json(updated)
}
