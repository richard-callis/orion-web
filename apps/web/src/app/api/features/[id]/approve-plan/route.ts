import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { computeWaves } from '@/lib/plan-waves'


/**
 * POST /api/features/:id/approve-plan
 *
 * Gates feature execution: sets planApprovedAt/planApprovedBy and computes the
 * execution wave for every task under the feature. The worker only picks up
 * tasks whose feature has planApprovedAt set.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const feature = await prisma.feature.findUnique({
    where: { id: (await params).id },
    include: { tasks: { select: { id: true, dependsOn: true } } },
  })
  if (!feature) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, feature.createdBy)

  if (!feature.plan) {
    return NextResponse.json({ error: 'Feature has no plan to approve' }, { status: 400 })
  }
  if (feature.tasks.length === 0) {
    return NextResponse.json({ error: 'Feature has no tasks to execute' }, { status: 400 })
  }

  const approvedBy = caller?.id ?? 'gateway'
  const approvedAt = new Date()
  const waveMap = computeWaves(feature.tasks)

  const planSnippet = (feature.plan ?? '').slice(0, 2000)
  const auditContent = `Plan approved by ${approvedBy} at ${approvedAt.toISOString()}\n\n${planSnippet}`

  await prisma.$transaction([
    prisma.feature.update({
      where: { id: feature.id },
      data: { planApprovedAt: approvedAt, planApprovedBy: approvedBy },
    }),
    ...feature.tasks.map(t =>
      prisma.task.update({
        where: { id: t.id },
        data: { wave: waveMap.get(t.id) ?? 0 },
      })
    ),
    prisma.taskEvent.createMany({
      data: feature.tasks.map(t => ({
        taskId: t.id,
        eventType: 'plan_approved',
        content: auditContent,
        agentId: null,
      })),
    }),
  ])

  const waveCount = new Set(waveMap.values()).size
  return NextResponse.json({
    ok: true,
    featureId: feature.id,
    taskCount: feature.tasks.length,
    waveCount,
    planApprovedBy: approvedBy,
  })
}
