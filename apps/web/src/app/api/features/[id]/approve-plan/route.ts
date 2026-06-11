import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'

interface WaveTask {
  id: string
  dependsOn: string[]
}

/**
 * Compute the execution wave for every task in a feature.
 *
 * Wave 0 = task with no dependencies. Wave N = 1 + the max wave of its
 * dependencies. Cycles are guarded (a task that transitively depends on
 * itself resolves to wave 0 rather than recursing forever).
 */
function computeWaves(tasks: WaveTask[]): Map<string, number> {
  const waveMap = new Map<string, number>()
  const taskMap = new Map(tasks.map(t => [t.id, t]))

  function getWave(taskId: string, visited = new Set<string>()): number {
    const cached = waveMap.get(taskId)
    if (cached !== undefined) return cached
    if (visited.has(taskId)) return 0 // cycle guard
    visited.add(taskId)
    const task = taskMap.get(taskId)
    // Unknown dependency IDs (outside this feature) are treated as wave-0 anchors.
    const deps = (task?.dependsOn ?? []).filter(depId => taskMap.has(depId))
    if (!task || deps.length === 0) {
      waveMap.set(taskId, 0)
      return 0
    }
    const maxDepWave = Math.max(...deps.map(depId => getWave(depId, new Set(visited))))
    const wave = maxDepWave + 1
    waveMap.set(taskId, wave)
    return wave
  }

  tasks.forEach(t => getWave(t.id))
  return waveMap
}

/**
 * POST /api/features/:id/approve-plan
 *
 * Gates feature execution: sets planApprovedAt/planApprovedBy and computes the
 * execution wave for every task under the feature. The worker only picks up
 * tasks whose feature has planApprovedAt set.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const feature = await prisma.feature.findUnique({
    where: { id: params.id },
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
