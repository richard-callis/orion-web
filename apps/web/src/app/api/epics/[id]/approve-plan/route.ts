import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { computeWaves } from '../../../features/[id]/approve-plan/route'

/**
 * POST /api/epics/:id/approve-plan
 *
 * Approves every feature under the epic that has a plan + tasks but is not yet
 * approved. For each such feature it sets planApprovedAt/planApprovedBy and
 * computes execution waves for its tasks.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const epic = await prisma.epic.findUnique({
    where: { id: params.id },
    include: {
      features: {
        include: { tasks: { select: { id: true, dependsOn: true } } },
      },
    },
  })
  if (!epic) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, epic.createdBy)

  const approvedBy = caller?.id ?? 'gateway'

  const toApprove = epic.features.filter(
    f => f.plan && f.planApprovedAt === null && f.tasks.length > 0
  )

  const ops: Prisma.PrismaPromise<unknown>[] = []
  for (const feature of toApprove) {
    const waveMap = computeWaves(feature.tasks)
    ops.push(
      prisma.feature.update({
        where: { id: feature.id },
        data: { planApprovedAt: new Date(), planApprovedBy: approvedBy },
      })
    )
    for (const t of feature.tasks) {
      ops.push(prisma.task.update({ where: { id: t.id }, data: { wave: waveMap.get(t.id) ?? 0 } }))
    }
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
