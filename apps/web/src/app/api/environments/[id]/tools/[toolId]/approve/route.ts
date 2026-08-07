import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { sanitizeCommand } from '@/lib/sanitize-command'

// POST /api/environments/[id]/tools/[toolId]/approve
// Approves a pending tool proposal — activates it so the gateway picks it up on next heartbeat.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; toolId: string }> }) {
  // SOC2: CR-001 — require admin to approve tools (prevents unauthorized tool activation)
  const user = await requireAdmin()

  // Verify env exists
  const env = await prisma.environment.findUnique({ where: { id: (await params).id }, select: { id: true, type: true } })
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

  // Optional: assign the newly-approved tool to a tool group instead of leaving
  // it implicitly unrestricted (see tool-permissions.ts — a tool in no ToolGroup
  // is callable by any agent) or tied only to the one agent that proposed it.
  // If the approver passes toolGroupId, wire the tool into that group here so
  // access is governed by the normal AgentGroup -> ToolGroup grant mechanism
  // from the moment it goes live. Callers are strongly encouraged to pass this.
  // SOC2: the approving admin can override execConfig before it goes live — validate any
  // shell command the same way the AI-generation path does, so hardening there can't be
  // bypassed by editing the command in the approval request instead.
  if (body.execConfig !== undefined && body.execConfig?.command) {
    try {
      body.execConfig = { ...body.execConfig, command: sanitizeCommand(String(body.execConfig.command), env.type) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: `Invalid execConfig.command: ${msg}` }, { status: 400 })
    }
  }

  const toolGroupId = typeof body.toolGroupId === 'string' && body.toolGroupId.trim() ? body.toolGroupId.trim() : undefined
  if (toolGroupId) {
    const toolGroup = await prisma.toolGroup.findUnique({ where: { id: toolGroupId }, select: { id: true, environmentId: true } })
    if (!toolGroup) return NextResponse.json({ error: 'toolGroupId not found' }, { status: 404 })
    if (toolGroup.environmentId !== (await params).id) {
      return NextResponse.json({ error: 'toolGroupId belongs to a different environment' }, { status: 400 })
    }
  }

  // Activation and group assignment must succeed or fail together — if the group
  // write failed after activation, the tool would sit `active` and in no
  // ToolGroup, which tool-permissions.ts treats as unrestricted for every agent.
  // That failure mode is worse than not approving it at all.
  const updated = await prisma.$transaction(async (tx) => {
    const tool = await tx.mcpTool.update({
      where: { id: (await params).toolId },
      data: {
        status:  'active',
        enabled: body.enabled !== false,
        ...(body.description !== undefined && { description: body.description }),
        ...(body.execConfig  !== undefined && { execConfig:  body.execConfig }),
        ...(body.inputSchema !== undefined && { inputSchema: body.inputSchema }),
      },
    })
    if (toolGroupId) {
      await tx.toolGroupTool.upsert({
        where:  { toolGroupId_toolId: { toolGroupId, toolId: tool.id } },
        create: { toolGroupId, toolId: tool.id },
        update: {},
      })
    }
    return tool
  })

  // SOC2: audit tool approval (activates gateway tool)
  logAudit({
    userId: user.id,
    action: 'tool_approve',
    target: `tool:${(await params).toolId}`,
    detail: { environmentId: (await params).id, toolName: tool.name, toolGroupId: toolGroupId ?? null },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({ ...updated, toolGroupId: toolGroupId ?? null })
}
