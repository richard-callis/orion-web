import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try { await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
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

    // Check if execution already exists (idempotent — same executionId returns existing row)
    const existing = await prisma.toolExecution.findUnique({
      where: { executionId },
    })

    if (existing) {
      return NextResponse.json(existing, { status: 200 })
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
  try { await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  try {
    const { searchParams } = new URL(req.url)
    const actorId = searchParams.get('actorId')
    const status = searchParams.get('status')
    const limit = Math.min(Number(searchParams.get('limit') || 100), 1000)

    const where: any = {}
    if (actorId) where.actorId = actorId
    if (status) where.status = status

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
