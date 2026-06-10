/**
 * GET /api/federation/status
 *
 * Returns current instance load metrics. Used by hub instances to pick the
 * least-loaded spoke for task routing.
 *
 * Auth: Bearer <federationToken> — must match any environment's federationToken.
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

export async function GET(req: NextRequest) {
  if (!(await validateFederationToken(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [runningTasks, pendingTasks, agentCount, firstEnv] = await Promise.all([
    prisma.task.count({ where: { status: 'in_progress' } }),
    prisma.task.count({ where: { status: 'pending' } }),
    prisma.agent.count({ where: { type: { not: 'human' } } }),
    prisma.environment.findFirst({ select: { id: true } }),
  ])

  return NextResponse.json({
    runningTasks,
    pendingTasks,
    agentCount,
    environmentId: firstEnv?.id ?? null,
  })
}
