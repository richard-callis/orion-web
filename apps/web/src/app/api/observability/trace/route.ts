import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

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

// POST /api/observability/trace — Report a trace from Gateway
export async function POST(req: NextRequest) {
  const body = await req.json()
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
