import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

/** POST /api/environments/:id/agents — link an agent to this environment */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const body = await req.json().catch(() => ({}))
  if (!body.agentId) return NextResponse.json({ error: 'agentId is required' }, { status: 400 })

  const [env, agent] = await Promise.all([
    prisma.environment.findUnique({ where: { id: (await params).id } }),
    prisma.agent.findUnique({ where: { id: body.agentId } }),
  ])
  if (!env)   return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  // Idempotent — ignore if already linked
  const existing = await prisma.agentEnvironment.findFirst({
    where: { agentId: body.agentId, environmentId: (await params).id },
  })
  if (existing) return NextResponse.json(existing, { status: 200 })

  const link = await prisma.agentEnvironment.create({
    data: { agentId: body.agentId, environmentId: (await params).id },
    include: { agent: true },
  })
  return NextResponse.json(link, { status: 201 })
}
