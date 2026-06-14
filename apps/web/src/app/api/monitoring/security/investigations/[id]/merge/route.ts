/**
 * POST /api/monitoring/security/investigations/[id]/merge
 *
 * Merge another investigation INTO the target (path param).
 * Deduplicates observables by (value, category), interleaves timeline by eventTime,
 * preserves all notes, updates incident FKs, closes the source investigation.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { recordAudit } from '../../_utils'

export const dynamic = 'force-dynamic'

const mergeSchema = z.object({
  sourceId: z.string().uuid(),
})

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const targetId = (await params).id
  const body = mergeSchema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const { sourceId } = body.data
  if (sourceId === targetId) {
    return NextResponse.json({ error: 'Cannot merge an investigation into itself' }, { status: 400 })
  }

  const [target, source] = await Promise.all([
    prisma.investigation.findUnique({ where: { id: targetId } }),
    prisma.investigation.findUnique({ where: { id: sourceId } }),
  ])

  if (!target) {
    return NextResponse.json({ error: 'Target investigation not found' }, { status: 404 })
  }
  if (!source) {
    return NextResponse.json({ error: 'Source investigation not found' }, { status: 404 })
  }

  const tx = await prisma.$transaction(async (tx) => {
    // 1. Move all incidents from source to target
    const sourceIncidentCount = await tx.incident.count({ where: { investigationId: sourceId } })
    await tx.incident.updateMany({
      where: { investigationId: sourceId },
      data: { investigationId: targetId },
    })

    // 2. Move all notes (preserve author attribution)
    await tx.investigationNote.updateMany({
      where: { investigationId: sourceId },
      data: { investigationId: targetId },
    })

    // 3. Merge observables — deduplicate by (value, category), higher confidence wins
    const sourceObservables = await tx.investigationObservable.findMany({
      where: { investigationId: sourceId },
    })

    for (const obs of sourceObservables) {
      const existing = await tx.investigationObservable.findUnique({
        where: { investigationId_value_category: { investigationId: targetId, value: obs.value, category: obs.category } },
        select: { confidence: true },
      })
      await tx.investigationObservable.upsert({
        where: {
          investigationId_value_category: {
            investigationId: targetId,
            value: obs.value,
            category: obs.category,
          },
        },
        create: {
          investigationId: targetId,
          value: obs.value,
          displayValue: obs.displayValue,
          category: obs.category,
          role: obs.role,
          verdict: obs.verdict,
          confidence: obs.confidence,
          severity: obs.severity,
          firstSeen: obs.firstSeen,
          lastSeen: obs.lastSeen,
          context: obs.context,
          verdictBy: obs.verdictBy,
          verdictAt: obs.verdictAt,
        },
        update: {
          confidence: { set: Math.max(obs.confidence, existing?.confidence ?? 0) },
          lastSeen: new Date(),
        },
      })
    }

    // 4. Interleave timeline entries by eventTime
    const sourceTimeline = await tx.investigationTimeline.findMany({
      where: { investigationId: sourceId },
    })
    for (const entry of sourceTimeline) {
      await tx.investigationTimeline.create({
        data: {
          investigationId: targetId,
          eventTime: entry.eventTime,
          eventType: entry.eventType,
          title: `[merged] ${entry.title}`,
          description: entry.description,
          source: entry.source,
          isPinned: entry.isPinned,
          payload: entry.payload ?? undefined,
        },
      })
    }

    // 5. Close source investigation
    const closedSource = await tx.investigation.update({
      where: { id: sourceId },
      data: {
        status: 'closed',
        resolutionType: 'inconclusive',
        resolution: `Merged into investigation ${targetId}`,
        closedAt: new Date(),
      },
    })

    // 6. Add merge timeline entries
    await tx.investigationTimeline.create({
      data: {
        investigationId: targetId, eventTime: new Date(),
        eventType: 'merge_target',
        title: `Merged investigation: ${source.name}`,
        description: `${sourceIncidentCount} incidents, ${sourceObservables.length} observables, ${sourceTimeline.length} timeline entries`,
        source: 'manual',
      },
    })

    await tx.investigationTimeline.create({
      data: {
        investigationId: sourceId, eventTime: new Date(),
        eventType: 'merge_source',
        title: `Merged into: ${target.name}`,
        source: 'manual',
      },
    })

    return { targetId, sourceId, observableCount: sourceObservables.length, timelineCount: sourceTimeline.length }
  })

  await recordAudit(targetId, 'admin', 'human', 'merge',
    { sourceId }, { merged: tx })
  await recordAudit(sourceId, 'admin', 'human', 'merge',
    { into: targetId }, { closed: true })

  return NextResponse.json({ ok: true, ...tx })
}
