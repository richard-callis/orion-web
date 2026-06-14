/**
 * POST /api/federation/tasks
 *
 * Accept a task dispatched from a hub instance. Creates the task locally
 * in this spoke's DB and marks it pending for the local worker to pick up.
 *
 * Auth: Bearer <federationToken>
 * Body: { taskId, title, description?, agentId?, metadata? }
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/encryption'
import { timingSafeEqual } from 'crypto'

/**
 * Constant-time string comparison that does not leak token length via timing.
 * If lengths differ we still call timingSafeEqual (on a dummy buffer) to
 * prevent an attacker from learning length via response time.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) {
    // Compare anyway to avoid timing leak, but return false
    timingSafeEqual(aBuf, aBuf)
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

async function validateFederationToken(req: NextRequest, environmentId: string): Promise<boolean> {
  if (!environmentId) return false

  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return false
  const token = auth.slice(7)

  const env = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { federationToken: true },
  })
  if (!env?.federationToken) return false

  try {
    const stored = decrypt(env.federationToken) // handles enc:v1: prefix and plaintext passthrough
    return constantTimeEqual(stored, token)
  } catch {
    /* fall through */
  }
  return false
}

export async function POST(req: NextRequest) {
  let body: {
    environmentId?: string
    taskId?: string
    title?: string
    description?: string | null
    agentId?: string | null
    metadata?: Record<string, unknown> | null
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.environmentId) {
    return NextResponse.json({ error: 'environmentId is required' }, { status: 400 })
  }

  if (!(await validateFederationToken(req, body.environmentId))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!body.taskId || !body.title) {
    return NextResponse.json({ error: 'taskId and title are required' }, { status: 400 })
  }

  // Verify the agent exists on this spoke and belongs to the same environment
  // as the federation relationship (MEDIUM-1: prevents hub from targeting agents
  // in other environments using a valid token for a different environment).
  if (body.agentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: body.agentId },
      select: {
        id: true,
        environments: {
          where: { environmentId: body.environmentId },
          select: { id: true },
        },
      },
    })
    if (!agent) {
      return NextResponse.json(
        { error: `Agent ${body.agentId} not found on this spoke` },
        { status: 422 },
      )
    }
    if (agent.environments.length === 0) {
      return NextResponse.json(
        { error: `Agent ${body.agentId} does not belong to the federated environment` },
        { status: 403 },
      )
    }
  }

  // Create-only — reject duplicate taskIds with 409 to prevent a compromised
  // spoke from force-resetting an in-progress or completed task to 'pending'.
  // Use try/catch on P2002 instead of a pre-check findUnique to avoid a
  // TOCTOU race where concurrent creates both pass the check before either commits.
  let task: { id: string; status: string }
  try {
    task = await prisma.task.create({
      data: {
        id: body.taskId,
        title: body.title,
        description: body.description ?? null,
        assignedAgent: body.agentId ?? null,
        createdBy: 'federation',
        status: 'pending',
        metadata: {
          ...(body.metadata as object | null ?? {}),
          federatedFrom: 'hub',
        } as object,
      },
      select: { id: true, status: true },
    })
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as any).code === 'P2002') {
      return NextResponse.json({ error: 'Task already exists', taskId: body.taskId }, { status: 409 })
    }
    throw e
  }

  // Acknowledge the dispatch if a FederatedDispatch record exists for this task
  await prisma.federatedDispatch
    .updateMany({
      where: { taskId: body.taskId, status: 'dispatched' },
      data: { status: 'acknowledged', acknowledgedAt: new Date() },
    })
    .catch(() => {})

  return NextResponse.json({ accepted: true, taskId: task.id }, { status: 201 })
}
