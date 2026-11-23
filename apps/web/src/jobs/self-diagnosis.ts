/**
 * Self-diagnosis: turns ORION's own failure signals into deduplicated Bug rows
 * with evidence attached. Detect and record only: no LLM, network or dispatcher.
 *
 * Every 10 minutes (worker scheduler) it reads signals since the last run
 * (watermark in SystemSetting; first run looks back 24 h) from SIGNAL_SOURCES,
 * groups them by fingerprint (source kind + normalized message, see
 * self-diagnosis-text.ts) and upserts one Bug per fingerprint.
 *
 * Severity (fixed rule, see severityFor): stale security source → high;
 * otherwise 3+ occurrences → medium; otherwise low. Severity is only ever
 * raised, never lowered, and never touched on a Bug a human has triaged.
 *
 * Status: new → open. Seen again after resolved/closed → open again with a
 * "regressed after being resolved" note in the evidence. triaged / in_progress
 * keep their status.
 *
 * Idempotent: each evidence entry carries the id of the row it came from, so a
 * row read twice (watermark overlap, retry after a failed run) counts once.
 *
 * Caps per run: MAX_SIGNALS signals, MAX_NEW_BUGS new Bugs. When either bites,
 * a warning is logged and the watermark stops at the first unprocessed signal,
 * so the rest is picked up next run.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { MAX_SIGNALS, SIGNAL_SOURCES } from './self-diagnosis-sources'
import { normalizeMessage, type Signal } from './self-diagnosis-text'

export const MAX_NEW_BUGS = 50
export const MAX_EVIDENCE = 10
const WATERMARK_KEY = 'self-diagnosis.watermark'
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000
const REGRESSION_NOTE = 'regressed after being resolved'
const SEVERITIES = ['low', 'medium', 'high', 'critical']

interface EvidenceEntry { ref: string; at: string; excerpt: string; note?: string }

export function severityFor(high: boolean, occurrences: number): string {
  return high ? 'high' : occurrences >= 3 ? 'medium' : 'low'
}

const toEntry = (s: Signal): EvidenceEntry => ({ ref: s.ref, at: s.at.toISOString(), excerpt: s.excerpt })

function readEvidence(v: Prisma.JsonValue | null): EvidenceEntry[] {
  return Array.isArray(v) ? (v as unknown as EvidenceEntry[]).filter(e => e && typeof e.ref === 'string') : []
}

const newestFirst = (a: EvidenceEntry, b: EvidenceEntry) => b.at.localeCompare(a.at)

async function readWatermark(now: Date): Promise<Date> {
  const row = await prisma.systemSetting.findUnique({ where: { key: WATERMARK_KEY } })
  const d = typeof row?.value === 'string' ? new Date(row.value) : null
  return d && !Number.isNaN(d.getTime()) ? d : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS)
}

export interface SelfDiagnosisResult { signals: number; created: number; updated: number; skipped: number }

export async function runSelfDiagnosis(now = new Date()): Promise<SelfDiagnosisResult> {
  const since = await readWatermark(now)
  const all = (await Promise.all(SIGNAL_SOURCES.map(s => s(since, now)))).flat()
  // State checks first, then windowed signals oldest-first, so a cap cuts the newest.
  const ordered = [...all.filter(s => !s.windowed), ...all.filter(s => s.windowed).sort((a, b) => a.at.getTime() - b.at.getTime())]
  const signals = ordered.slice(0, MAX_SIGNALS)
  let resumeAt: Date | null = null
  if (ordered.length > signals.length) {
    console.warn(`[self-diagnosis] ${ordered.length} signals, processing the first ${MAX_SIGNALS}; the rest wait for the next run`)
    resumeAt = signals.filter(s => s.windowed).at(-1)?.at ?? since
  }

  const groups = new Map<string, Signal[]>()
  for (const s of signals) groups.set(s.fingerprint, [...(groups.get(s.fingerprint) ?? []), s])
  const existing = new Map(
    (await prisma.bug.findMany({ where: { fingerprint: { in: [...groups.keys()] } } })).map(b => [b.fingerprint!, b]),
  )

  const result: SelfDiagnosisResult = { signals: signals.length, created: 0, updated: 0, skipped: 0 }
  const holdBack = (group: Signal[]) => {
    result.skipped++
    for (const s of group.filter(x => x.windowed)) if (!resumeAt || s.at < resumeAt) resumeAt = s.at
  }
  for (const [fingerprint, group] of groups) {
    try {
      const bug = existing.get(fingerprint)
      if (bug) {
        if (await bumpBug(bug, group)) result.updated++
      } else if (result.created >= MAX_NEW_BUGS) {
        holdBack(group)
      } else {
        await createBug(fingerprint, group)
        result.created++
      }
    } catch (e) {
      console.error(`[self-diagnosis] could not record ${fingerprint.slice(0, 12)}:`, e)
      holdBack(group)
    }
  }
  if (result.skipped > 0) {
    console.warn(`[self-diagnosis] ${result.skipped} fault group(s) not recorded this run (new-bug cap ${MAX_NEW_BUGS} or errors); retrying next run`)
  }

  const watermark = resumeAt ?? now
  await prisma.systemSetting.upsert({
    where: { key: WATERMARK_KEY },
    create: { key: WATERMARK_KEY, value: watermark.toISOString() },
    update: { value: watermark.toISOString() },
  })
  return result
}

/** One signal per ref (a row read twice counts once), oldest first. */
function uniqueSignals(group: Signal[]): Signal[] {
  return [...new Map(group.map(s => [s.ref, s])).values()].sort((a, b) => a.at.getTime() - b.at.getTime())
}

async function createBug(fingerprint: string, group: Signal[]): Promise<void> {
  const signals = uniqueSignals(group)
  const first = signals[0]
  const last = signals.at(-1)!
  await prisma.bug.create({
    data: {
      title: `${first.area}: ${normalizeMessage(first.message)}`.slice(0, 120),
      description: `Self-diagnosis saw this ${signals.length} time(s) in its first look (signal: ${first.kind}). Latest: ${last.message}`,
      severity: severityFor(first.high, signals.length),
      status: 'open',
      reportedBy: 'orion',
      area: first.area,
      source: 'self-diagnosis',
      fingerprint,
      occurrences: signals.length,
      firstSeenAt: first.at,
      lastSeenAt: last.at,
      evidence: signals.map(toEntry).sort(newestFirst).slice(0, MAX_EVIDENCE) as unknown as Prisma.InputJsonValue,
    },
  })
}

/** Returns false when every signal was already recorded. */
async function bumpBug(bug: Prisma.BugGetPayload<object>, group: Signal[]): Promise<boolean> {
  const old = readEvidence(bug.evidence)
  const known = new Set(old.map(e => e.ref))
  const fresh = uniqueSignals(group).filter(s => !known.has(s.ref))
  if (fresh.length === 0) return false

  const regressed = bug.status === 'resolved' || bug.status === 'closed'
  const entries = fresh.map(toEntry).sort(newestFirst)
  if (regressed) entries[0].note = REGRESSION_NOTE
  const occurrences = bug.occurrences + fresh.length
  const wanted = severityFor(fresh[0].high, occurrences)
  const raise = bug.status !== 'triaged' && bug.status !== 'in_progress' && SEVERITIES.indexOf(wanted) > SEVERITIES.indexOf(bug.severity)
  const lastSeen = fresh.at(-1)!.at
  await prisma.bug.update({
    where: { id: bug.id },
    data: {
      occurrences,
      lastSeenAt: bug.lastSeenAt && bug.lastSeenAt > lastSeen ? bug.lastSeenAt : lastSeen,
      evidence: [...entries, ...old].sort(newestFirst).slice(0, MAX_EVIDENCE) as unknown as Prisma.InputJsonValue,
      ...(regressed ? { status: 'open' } : {}),
      ...(raise ? { severity: wanted } : {}),
    },
  })
  return true
}
