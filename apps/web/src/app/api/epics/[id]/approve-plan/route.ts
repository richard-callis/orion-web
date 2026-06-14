import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { computeWaves } from '@/lib/plan-waves'

/**
 * POST /api/epics/:id/approve-plan
 *
 * Approves every feature under the epic that has a plan + tasks but is not yet
 * approved. For each such feature it sets planApprovedAt/planApprovedBy and
 * computes execution waves for its tasks.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const epic = await prisma.epic.findUnique({
    where: { id: (await params).id },
    include: {
      features: {
        include: { tasks: { select: { id: true, dependsOn: true } } },
      },
    },
  })
  if (!epic) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, epic.createdBy)

  const approvedBy = caller?.id ?? 'gateway'
  const approvedAt = new Date()

  const toApprove = epic.features.filter(
    f => f.plan && f.planApprovedAt === null && f.tasks.length > 0
  )

  const ops: Prisma.PrismaPromise<unknown>[] = []
  for (const feature of toApprove) {
    const waveMap = computeWaves(feature.tasks)
    ops.push(
      prisma.feature.update({
        where: { id: feature.id },
        data: { planApprovedAt: approvedAt, planApprovedBy: approvedBy },
      })
    )
    for (const t of feature.tasks) {
      ops.push(prisma.task.update({ where: { id: t.id }, data: { wave: waveMap.get(t.id) ?? 0 } }))
    }
    const planSnippet = (feature.plan ?? '').slice(0, 2000)
    const auditContent = `Plan approved by ${approvedBy} at ${approvedAt.toISOString()}\n\n${planSnippet}`
    ops.push(
      prisma.taskEvent.createMany({
        data: feature.tasks.map(t => ({
          taskId: t.id,
          eventType: 'plan_approved',
          content: auditContent,
          agentId: null,
        })),
      })
    )
  }

  if (ops.length > 0) await prisma.$transaction(ops)

  return NextResponse.json({
    ok: true,
    epicId: epic.id,
    approvedFeatures: toApprove.map(f => f.id),
    approvedCount: toApprove.length,
    planApprovedBy: approvedBy,
  })
}
