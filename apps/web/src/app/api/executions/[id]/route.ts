import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify, isExecutorServiceCall } from '@/lib/auth'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let caller
  try { caller = await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const isService = caller === null
  try {
    const execution = await prisma.toolExecution.findUnique({
      where: { id: (await params).id },
    })

    if (!execution) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      )
    }

    try {
      await assertCanModify(caller, isService, execution.actorId ?? '')
    } catch {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json(execution)
  } catch (error) {
    console.error('Error getting execution:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // SOC2 [C2]: execution records are updated only by the executor service. Human
  // approve/deny decisions go through POST /api/executions/[id]/review (admin-only,
  // reviewer != actor). Previously any session whose id matched actorId could PATCH
  // reviewDecision: 'approved' on its own request.
  if (!isExecutorServiceCall(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const existing = await prisma.toolExecution.findUnique({
      where: { id: (await params).id },
    })
    if (!existing) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      )
    }

    const body = await req.json()

    const {
      status,
      riskTier,
      exitCode,
      output,
      durationMs,
      reviewerId,
      reviewDecision,
      reviewedAt,
      expiresAt,
      completedAt,
    } = body

    // The executor may record a denial (TTL auto-deny) but never an approval or a
    // reviewer identity — those come only from the human review endpoint.
    if (reviewDecision !== undefined && reviewDecision !== 'denied') {
      return NextResponse.json(
        { error: 'Approvals must be recorded via /api/executions/[id]/review' },
        { status: 403 }
      )
    }
    if (reviewerId !== undefined) {
      return NextResponse.json({ error: 'reviewerId cannot be set by the executor' }, { status: 403 })
    }

    // Build update object with only provided fields
    const updateData: any = {}
    if (status !== undefined) updateData.status = status
    if (riskTier !== undefined) updateData.riskTier = riskTier
    if (exitCode !== undefined) updateData.exitCode = exitCode
    if (output !== undefined) updateData.output = output
    if (durationMs !== undefined) updateData.durationMs = durationMs
    if (reviewDecision !== undefined) updateData.reviewDecision = reviewDecision
    if (reviewedAt !== undefined) updateData.reviewedAt = reviewedAt
    if (expiresAt !== undefined) updateData.expiresAt = expiresAt
    if (completedAt !== undefined) updateData.completedAt = completedAt

    const execution = await prisma.toolExecution.update({
      where: { id: (await params).id },
      data: updateData,
    })

    return NextResponse.json(execution)
  } catch (error: any) {
    if (error?.code === 'P2025') {
      // Not found
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      )
    }
    console.error('Error updating execution:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
