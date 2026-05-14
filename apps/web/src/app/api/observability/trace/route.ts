import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError } from '@/lib/validate'

export const dynamic = 'force-dynamic'

// SOC2 [INPUT-001]: Validate trace write inputs
const CreateTraceSchema = z.object({
  conversationId: z.string().optional(),
  taskId: z.string().optional(),
  step: z.number().int().min(0),
  type: z.string().min(1).max(64),
  toolName: z.string().max(128).optional(),
  toolArgs: z.record(z.unknown()).optional(),
  toolResult: z.unknown().optional(),
  content: z.string().optional(),
  skillName: z.string().max(128).optional(),
  hookName: z.string().max(128).optional(),
  durationMs: z.number().int().min(0).optional(),
  modelUsed: z.string().max(128).optional(),
  systemPromptHash: z.string().max(256).optional(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
  costCents: z.number().min(0).optional(),
})

// GET /api/observability/trace — Query traces
// Query params: conversationId, taskId, limit (default 100), type (optional filter)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const conversationId = searchParams.get('conversationId')
  const taskId = searchParams.get('taskId')
  const type = searchParams.get('type')
  const limit = parseInt(searchParams.get('limit') || '100')

  const where: Record<string, unknown> = {}
  if (conversationId) where.conversationId = conversationId
  if (taskId) where.taskId = taskId
  if (type) where.type = type

  const traces = await prisma.agentTrace.findMany({
    where,
    orderBy: { step: 'asc' },
    take: limit,
  })
  return NextResponse.json(traces)
}

// POST /api/observability/trace — Report a trace from Gateway (gateway token required)
export async function POST(req: NextRequest) {
  try {
    await requireServiceAuth(req)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await parseBodyOrError(req, CreateTraceSchema)
  if ('error' in result) return result.error
  const body = result.data

  const trace = await prisma.agentTrace.create({
    data: {
      conversationId: body.conversationId,
      taskId: body.taskId,
      step: body.step,
      type: body.type,
      toolName: body.toolName,
      toolArgs: body.toolArgs ? JSON.stringify(body.toolArgs) : null,
      toolResult: body.toolResult ? JSON.stringify(body.toolResult) : null,
      content: body.content,
      skillName: body.skillName,
      hookName: body.hookName,
      durationMs: body.durationMs,
      modelUsed: body.modelUsed,
      systemPromptHash: body.systemPromptHash,
      tokensIn: body.tokensIn,
      tokensOut: body.tokensOut,
      costCents: body.costCents ? parseFloat(String(body.costCents)) : null,
    },
  })
  return NextResponse.json(trace)
}
