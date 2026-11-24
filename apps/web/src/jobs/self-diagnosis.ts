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
 * "regressed after being resolved" note in the evidence, unless every new signal
 * is from before, or within 30 min after, the newest merged-fix note
 * (jobs/self-improvement.ts; the fix may not be deployed yet). triaged / in_progress keep their status.
 *
 * Re-reads are mostly harmless: evidence entries carry the id of the row they
 * came from and windowed signals older than the Bug's lastSeenAt are skipped,
 * so a row read twice (watermark overlap, retry after a failed run) counts
 * once. Not airtight for more than MAX_EVIDENCE rows of one fault within
 * OVERLAP_MS of each other, which can be counted again if re-read.
 *
 * Caps per run: MAX_SIGNALS signals (also per source), MAX_NEW_BUGS new Bugs.
 * When either bites, a warning is logged and the watermark stops at the first
 * unprocessed signal, so the rest is picked up next run. The watermark never
 * reads further back than 24 h (readWatermark), so a fault group that cannot
 * be stored, or a source that keeps failing, is retried for at most 24 h and
 * cannot pin the watermark forever. A stored watermark older than that is
 * clamped with a warning, so signals before the floor are skipped, not silently.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { MAX_SIGNALS, SIGNAL_SOURCES } from './self-diagnosis-sources'
import { normalizeMessage, type Signal } from './self-diagnosis-text'

export const MAX_NEW_BUGS = 50
export const MAX_EVIDENCE = 10
const WATERMARK_KEY = 'self-diagnosis.watermark'
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000
const OVERLAP_MS = 2 * 60_000
const REGRESSION_NOTE = 'regressed after being resolved'
// Signals from before a merged fix (note ref "fix:<task>", jobs/self-improvement.ts) or this soon after it may predate its deploy.
const DEPLOY_GRACE_MS = 30 * 60_000
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
  const floor = new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS)
  if (d && !Number.isNaN(d.getTime()) && d <= floor) {
    console.warn(`[self-diagnosis] watermark ${d.toISOString()} is older than 24 h; signals before ${floor.toISOString()} are skipped`)
  }
  return d && !Number.isNaN(d.getTime()) && d > floor ? d : floor
}

export interface SelfDiagnosisResult { signals: number; created: number; updated: number; skipped: number }

export async function runSelfDiagnosis(now = new Date()): Promise<SelfDiagnosisResult> {
  const since = await readWatermark(now)
  let resumeAt: Date | null = null
  const hold = (d: Date) => { if (!resumeAt || d < resumeAt) resumeAt = d }
  const settled = await Promise.allSettled(SIGNAL_SOURCES.map(s => s.read(since, now)))
  const all: Signal[] = []
  settled.forEach((r, i) => {
    const src = SIGNAL_SOURCES[i]
    if (r.status === 'rejected') {
      console.error(`[self-diagnosis] source ${src.name} failed:`, r.reason)
      if (src.windowed) hold(since) // read its rows again next run
      return
    }
    all.push(...r.value.signals)
    if (r.value.truncated) {
      console.warn(`[self-diagnosis] source ${src.name} has more than ${MAX_SIGNALS} signals; the rest wait for the next run`)
      hold(r.value.signals.at(-1)?.at ?? since)
    }
  })
  // State checks first, then windowed signals oldest-first, so a cap cuts the newest.
  const ordered = [...all.filter(s => !s.windowed), ...all.filter(s => s.windowed).sort((a, b) => a.at.getTime() - b.at.getTime())]
  const signals = ordered.slice(0, MAX_SIGNALS)
  if (ordered.length > signals.length) {
    console.warn(`[self-diagnosis] ${ordered.length} signals, processing the first ${MAX_SIGNALS}; the rest wait for the next run`)
    hold(signals.filter(s => s.windowed).at(-1)?.at ?? since)
  }

  const groups = new Map<string, Signal[]>()
  for (const s of signals) groups.set(s.fingerprint, [...(groups.get(s.fingerprint) ?? []), s])
  const existing = new Map(
    (await prisma.bug.findMany({ where: { fingerprint: { in: [...groups.keys()] } } })).map(b => [b.fingerprint!, b]),
  )

  const result: SelfDiagnosisResult = { signals: signals.length, created: 0, updated: 0, skipped: 0 }
  const holdBack = (group: Signal[]) => {
    result.skipped++
    for (const s of group.filter(x => x.windowed)) hold(s.at)
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

  // Two minutes of overlap: a row stamped just before `now` may commit after the query ran.
  const overlapStart = new Date(now.getTime() - OVERLAP_MS)
  const held = resumeAt as Date | null // assigned in closures, so TS narrows it to never
  const watermark: Date = held && held < overlapStart ? held : overlapStart
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
      description: `First seen ${first.at.toISOString()} (signal ${first.kind}): ${first.message}`,
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
  const fresh = uniqueSignals(group).filter(s => !known.has(s.ref) && !(s.windowed && bug.lastSeenAt && s.at.getTime() < bug.lastSeenAt.getTime() - OVERLAP_MS))
  if (fresh.length === 0) return false

  // Older signals still count, but do not reopen a Bug within the deploy grace of its merged fix.
  const fixedAt = old.filter(e => e.ref.startsWith('fix:')).map(e => Date.parse(e.at)).filter(t => !Number.isNaN(t)).sort((a, b) => b - a)[0]
  const regressed = (bug.status === 'resolved' || bug.status === 'closed') && fresh.some(s => fixedAt === undefined || s.at.getTime() > fixedAt + DEPLOY_GRACE_MS)
  const entries = fresh.map(toEntry)
  const occurrences = bug.occurrences + fresh.length
  const wanted = severityFor(fresh[0].high, occurrences)
  const raise = bug.status !== 'triaged' && bug.status !== 'in_progress' && SEVERITIES.indexOf(wanted) > SEVERITIES.indexOf(bug.severity)
  const lastSeen = fresh.at(-1)!.at
  // The regression note is its own entry, kept apart from the capped occurrence entries.
  if (regressed) entries.push({ ref: `regression:${lastSeen.toISOString()}`, at: lastSeen.toISOString(), excerpt: '', note: REGRESSION_NOTE })
  const merged = [...entries, ...old].sort(newestFirst)
  const evidence = [...merged.filter(e => !e.note).slice(0, MAX_EVIDENCE), ...merged.filter(e => e.note).slice(0, MAX_EVIDENCE)].sort(newestFirst)
  await prisma.bug.update({
    where: { id: bug.id },
    data: {
      occurrences,
      lastSeenAt: bug.lastSeenAt && bug.lastSeenAt > lastSeen ? bug.lastSeenAt : lastSeen,
      evidence: evidence as unknown as Prisma.InputJsonValue,
      ...(regressed ? {
        status: 'open',
        description: `${bug.description ?? ''}\nRegressed ${lastSeen.toISOString()} after being resolved (${occurrences} occurrences so far).`,
      } : {}),
      ...(raise ? { severity: wanted } : {}),
    },
  })
  return true
}
