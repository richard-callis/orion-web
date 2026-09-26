import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, isExecutorServiceCall } from '@/lib/auth'

export async function POST(req: NextRequest) {
  // SOC2 [C2]: only the executor service may create execution records. Sessions and
  // the gateway token are rejected — a user-created pending row could otherwise be
  // self-approved and then run by the executor.
  if (!isExecutorServiceCall(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json()

    const {
      executionId,
      environmentId,
      tool,
      args,
      actorId,
      actorType,
      riskTier,
      status,
    } = body

    // Validate required fields
    if (!executionId || !tool || !actorId || !actorType || !status) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    // New records always start pending; decisions are recorded via the review endpoint.
    if (status !== 'pending') {
      return NextResponse.json({ error: 'New executions must have status "pending"' }, { status: 400 })
    }

    // Idempotent retry: the same executionId returns the existing row ONLY while it is
    // still freshly pending. Re-submitting an executionId that was already reviewed or
    // run is a replay — returning the old row (e.g. reviewDecision: 'approved') would
    // make the executor run the command again.
    const existing = await prisma.toolExecution.findUnique({
      where: { executionId },
    })

    if (existing) {
      if (existing.status === 'pending' && !existing.reviewDecision) {
        return NextResponse.json(existing, { status: 200 })
      }
      return NextResponse.json(
        { error: 'Execution already exists and is no longer pending' },
        { status: 409 }
      )
    }

    // Create new execution record
    const execution = await prisma.toolExecution.create({
      data: {
        executionId,
        environmentId: environmentId || null,
        tool,
        args: args || {},
        actorId,
        actorType,
        riskTier: riskTier || 'notify',
        status,
      },
    })

    return NextResponse.json(execution, { status: 201 })
  } catch (error) {
    console.error('Error creating execution:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireServiceAuth>>
  try { caller = await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const isService = caller === null
  try {
    const { searchParams } = new URL(req.url)
    const actorId = searchParams.get('actorId')
    const status = searchParams.get('status')
    const limit = Math.min(Number(searchParams.get('limit') || 100), 1000)

    const where: any = {}
    if (actorId) where.actorId = actorId
    if (status) where.status = status

    // SOC2: scope list to the caller's own executions unless admin or service/gateway
    if (!isService && caller && caller.role !== 'admin') {
      where.actorId = caller.id
    }

    const executions = await prisma.toolExecution.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    return NextResponse.json(executions)
  } catch (error) {
    console.error('Error listing executions:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
