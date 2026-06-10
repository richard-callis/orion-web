import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)

  let body: { agentId: string; modelId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.agentId) {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
  }

  // Load suite with cases
  const suite = await prisma.evalSuite.findUnique({
    where: { id: params.id },
    include: { cases: true },
  })
  if (!suite) return NextResponse.json({ error: 'Suite not found' }, { status: 404 })
  if (suite.cases.length === 0) {
    return NextResponse.json({ error: 'Suite has no cases' }, { status: 400 })
  }

  // Resolve agent + modelId
  const agent = await prisma.agent.findUnique({ where: { id: body.agentId } })
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  // Determine modelId: use provided, or fall back to agent metadata, or 'default'
  let modelId = body.modelId
  if (!modelId) {
    const meta = agent.metadata as { modelId?: string } | null
    modelId = meta?.modelId ?? 'default'
  }

  // Create EvalRun
  const run = await prisma.evalRun.create({
    data: {
      suiteId: params.id,
      agentId: body.agentId,
      modelId,
      status: 'pending',
    },
  })

  // For each case: create a Task and an EvalCaseResult (pending)
  const createdBy = caller?.id ?? 'eval-harness'
  for (const evalCase of suite.cases) {
    const task = await prisma.task.create({
      data: {
        title: evalCase.title,
        description: evalCase.prompt,
        assignedAgent: body.agentId,
        status: 'pending',
        priority: 'medium',
        createdBy,
      } as any,
    })

    await prisma.evalCaseResult.create({
      data: {
        runId: run.id,
        caseId: evalCase.id,
        taskId: task.id,
        passed: null,
        assertions: JSON.stringify([]),
      },
    })
  }

  // Update run to running
  await prisma.evalRun.update({
    where: { id: run.id },
    data: { status: 'running', startedAt: new Date() },
  })

  return NextResponse.json({ runId: run.id }, { status: 201 })
}
