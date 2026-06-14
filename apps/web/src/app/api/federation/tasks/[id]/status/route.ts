/**
 * GET /api/federation/tasks/[id]/status
 *
 * Returns task status so a hub can poll for completion.
 *
 * Auth: Bearer <federationToken>
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

async function validateFederationToken(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return false
  const token = auth.slice(7)

  const env = await prisma.environment.findFirst({
    where: { federationToken: token },
    select: { id: true },
  })
  return env !== null
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await validateFederationToken(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const task = await prisma.task.findUnique({
    where: { id: (await params).id },
    select: { id: true, status: true, updatedAt: true, metadata: true },
  })

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  return NextResponse.json({
    taskId: task.id,
    status: task.status,
    updatedAt: task.updatedAt,
  })
}
