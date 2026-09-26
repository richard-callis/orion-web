/**
 * POST /api/executions/[id]/review
 *
 * Record a human approve/deny decision on a pending executor execution.
 * [id] may be the ToolExecution id or its executionId (the UUID shown in the
 * system.room.execution notification).
 *
 * Auth: admin session only (MFA-verified if enabled). Service tokens are rejected.
 * The reviewer may not be the actor that requested the execution.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { reviewExecution, ExecutionReviewError } from '@/lib/execution-review'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { decision?: unknown; reason?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const execution = await reviewExecution({
      id: (await params).id,
      reviewer: user,
      decision: body.decision as 'approved' | 'denied',
      reason: typeof body.reason === 'string' ? body.reason : '',
    })
    return NextResponse.json(execution)
  } catch (error) {
    if (error instanceof ExecutionReviewError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error reviewing execution:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
