/**
 * GET /api/monitoring/security/investigations/[id]/report
 *
 * Generate a markdown investigation report.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const id = (await params).id

  const investigation = await prisma.investigation.findUnique({
    where: { id },
    include: {
      incidents: { orderBy: { openedAt: 'asc' } },
      notes: { orderBy: { createdAt: 'asc' } },
      observables: { orderBy: { firstSeen: 'asc' } },
      timeline: { orderBy: { eventTime: 'asc' } },
    },
  })

  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  const lines: string[] = []
  lines.push(`# ${investigation.name}`)
  lines.push(``)
  lines.push(`| Field | Value |`)
  lines.push(`|-------|-------|`)
  lines.push(`| Status | ${investigation.status} |`)
  lines.push(`| Severity | ${investigation.severity}/100 |`)
  lines.push(`| TLP | ${investigation.tlp} |`)
  lines.push(`| Created | ${investigation.startedAt.toISOString()} |`)
  if (investigation.resolvedAt) lines.push(`| Resolved | ${investigation.resolvedAt.toISOString()} |`)
  if (investigation.closedAt) lines.push(`| Closed | ${investigation.closedAt.toISOString()} |`)
  if (investigation.resolutionType) lines.push(`| Resolution | ${investigation.resolutionType} |`)
  if (investigation.mitreAttackIds.length) lines.push(`| MITRE ATT&CK | ${investigation.mitreAttackIds.join(', ')} |`)
  lines.push(``)

  // Summary
  if (investigation.resolution) {
    lines.push(`## Summary`)
    lines.push(``)
    lines.push(investigation.resolution)
    lines.push(``)
  }

  // Linked Incidents
  if (investigation.incidents.length) {
    lines.push(`## Linked Incidents (${investigation.incidents.length})`)
    lines.push(``)
    for (const inc of investigation.incidents) {
      lines.push(`- **[${inc.status}]** ${inc.attackerKey ?? 'Unknown'} (sev: ${inc.severity}) — ${inc.openedAt.toISOString()}`)
    }
    lines.push(``)
  }

  // Observables
  if (investigation.observables.length) {
    lines.push(`## Observables (${investigation.observables.length})`)
    lines.push(``)
    lines.push(`| Value | Category | Verdict | Confidence | First Seen |`)
    lines.push(`|-------|----------|---------|------------|------------|`)
    for (const obs of investigation.observables) {
      lines.push(`| ${obs.displayValue} | ${obs.category} | ${obs.verdict} | ${obs.confidence}% | ${obs.firstSeen.toISOString()} |`)
    }
    lines.push(``)
  }

  // Timeline
  if (investigation.timeline.length) {
    lines.push(`## Timeline`)
    lines.push(``)
    for (const entry of investigation.timeline) {
      const sourceBadge = entry.source === 'warden' ? '[Warden]' : entry.source === 'correlator' ? '[Auto]' : ''
      lines.push(`- **${entry.eventTime.toISOString()}** — ${entry.title} ${sourceBadge}`)
      if (entry.description) lines.push(`  - ${entry.description}`)
    }
    lines.push(``)
  }

  // Notes
  if (investigation.notes.length) {
    lines.push(`## Notes (${investigation.notes.length})`)
    lines.push(``)
    for (const note of investigation.notes) {
      const authorLabel = note.authorType === 'warden' ? 'Warden' : note.author
      lines.push(`### ${authorLabel} — ${note.createdAt.toISOString()}`)
      lines.push(``)
      lines.push(note.content)
      lines.push(``)
    }
  }

  // Metrics
  lines.push(`---`)
  lines.push(`*Report generated ${new Date().toISOString()}*`)

  return NextResponse.json({ markdown: lines.join('\n') })
}
