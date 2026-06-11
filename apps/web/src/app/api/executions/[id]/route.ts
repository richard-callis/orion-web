import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try { await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  try {
    const execution = await prisma.toolExecution.findUnique({
      where: { id: params.id },
    })

    if (!execution) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      )
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
  { params }: { params: { id: string } }
) {
  try { await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  try {
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

    // Build update object with only provided fields
    const updateData: any = {}
    if (status !== undefined) updateData.status = status
    if (riskTier !== undefined) updateData.riskTier = riskTier
    if (exitCode !== undefined) updateData.exitCode = exitCode
    if (output !== undefined) updateData.output = output
    if (durationMs !== undefined) updateData.durationMs = durationMs
    if (reviewerId !== undefined) updateData.reviewerId = reviewerId
    if (reviewDecision !== undefined) updateData.reviewDecision = reviewDecision
    if (reviewedAt !== undefined) updateData.reviewedAt = reviewedAt
    if (expiresAt !== undefined) updateData.expiresAt = expiresAt
    if (completedAt !== undefined) updateData.completedAt = completedAt

    const execution = await prisma.toolExecution.update({
      where: { id: params.id },
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
