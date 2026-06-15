/**
 * GET /api/monitoring/security/sources
 *
 * Returns health status for all security sources, merging both:
 *   - SourceHealth     — global sources (crowdsec, wazuh, elk, ntopng, host_agent)
 *                        written by Phase 1 webhook/poller handlers
 *   - EnvironmentSourceHealth — per-env sources (falco, k8s_events)
 *                        written by Phase 2 Falco/K8s webhook handlers
 *
 * Previously only queried SourceHealth, so Falco (which writes to
 * EnvironmentSourceHealth) always showed "No sources configured."
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { computeSourceStatus } from '@/lib/security/source-health-utils'

export const dynamic = 'force-dynamic'

export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const now = Date.now()

  // Global sources (Phase 1)
  const globalSources = await prisma.sourceHealth.findMany({
    select: {
      source: true,
      lastSeenAt: true,
      lastWatermark: true,
      staleAfterMs: true,
      environmentId: true,
    },
  })

  // Per-environment sources (Phase 2 — Falco, k8s_events)
  // Group by source name and take the most recent lastSeenAt across all envs
  // so the panel shows one row per source type, not one per environment.
  const envSources = await prisma.environmentSourceHealth.findMany({
    select: {
      source: true,
      lastSeenAt: true,
      lastWatermark: true,
      staleAfterMs: true,
      environmentId: true,
    },
  })

  // Deduplicate per-env sources by name, keeping the most recently seen row
  const envBySource = new Map<string, typeof envSources[number]>()
  for (const s of envSources) {
    const existing = envBySource.get(s.source)
    const existingTs = existing?.lastSeenAt ? new Date(existing.lastSeenAt).getTime() : 0
    const thisTs = s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : 0
    if (!existing || thisTs > existingTs) {
      envBySource.set(s.source, s)
    }
  }

  // Merge: global sources take precedence over env sources with the same name
  const globalNames = new Set(globalSources.map(s => s.source))
  const merged = [
    ...globalSources,
    ...[...envBySource.values()].filter(s => !globalNames.has(s.source)),
  ]

  // Count SecurityEvents per source in the last 24h to surface alert volume.
  // Known limitation (best-effort): ELK events are written with source='elk'
  // but the corresponding health rows use 'elk_syslog'/'elk_flow', so those
  // ELK health rows won't match and will report alertCount24h: 0. We map
  // defensively — any source name with no matching event group gets 0.
  const since24h = new Date(Date.now() - 86_400_000)
  const alertCounts = await prisma.securityEvent.groupBy({
    by: ['source'],
    where: { createdAt: { gte: since24h } },
    _count: { id: true },
  })
  const alertCountMap = new Map(alertCounts.map(r => [r.source, r._count.id]))

  const result = merged.map(s => {
    const lastSeen = s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : 0
    const status = computeSourceStatus(lastSeen, now, s.staleAfterMs)
    return {
      source: s.source,
      lastSeenAt: s.lastSeenAt,
      lastWatermark: s.lastWatermark,
      staleAfterMs: s.staleAfterMs,
      environmentId: s.environmentId,
      status,
      alertCount24h: alertCountMap.get(s.source) ?? 0,
    }
  })

  return NextResponse.json({ sources: result })
}
