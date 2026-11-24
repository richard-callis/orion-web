/**
 * Self-improvement: asks the agent dispatcher to fix ORION's own self-diagnosed
 * bugs (see lib/dispatcher-requests.ts). ORION never writes code itself; the
 * dispatcher runs a coding agent that opens a PR the owner reviews.
 *
 * Every 15 minutes (worker scheduler); does nothing unless the dispatcher client
 * is configured AND ORION_SELF_IMPROVEMENT=on (ORION's own switch; the dispatcher
 * has another). Each run:
 *  1. reads the dispatcher's requests (if that fails, nothing else happens);
 *  2. syncs every request whose ref is a Bug id into the Bug's fix* fields,
 *     records the growth of its usage, and resolves the Bug when its gate merged;
 *  3. unless the dispatcher is paused or a limit is reached, sends at most ONE
 *     request: the oldest open self-diagnosis Bug with no request yet, severity
 *     high/critical (or medium with 3+ occurrences), seen in the last 24 h.
 *
 * Resolved-on-merge is the only verification: self-diagnosis reopens the Bug
 * ("regressed") if the same fault shows up after the fix is deployed.
 *
 * Token accounting: usage deltas (not totals) go to AgentTokenUsage via
 * recordTokenUsage under the Alpha system agent (modelId "dispatcher"). Alpha is
 * the coordinator that hands work to other agents, and a new agent would need a
 * seed entry with prompts. Input = input + cache creation + cache read tokens.
 * Usage is recorded before the Bug's stored usage moves on, so a failure in
 * between can double-count one delta but never lose it. If Alpha does not exist
 * yet, nothing is recorded and the baseline stays put, so it is caught up later.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { recordTokenUsage } from '@/lib/token-budget'
import {
  createRequest, isDispatcherConfigured, listRequests,
  type DispatcherOverview, type DispatcherRequest, type DispatcherUsage,
} from '@/lib/dispatcher-requests'
import { redact } from './self-diagnosis-text'

const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN_AGENT = 'Alpha'
const MAX_PROBLEM = 8000
const MAX_EVIDENCE_TEXT = 20000

type Bug = Prisma.BugGetPayload<object>
export interface SelfImprovementResult { skipped?: string; synced: number; sent: string | null }

export const isSelfImprovementOn = () => process.env.ORION_SELF_IMPROVEMENT === 'on' && isDispatcherConfigured()

const limitReached = (o: DispatcherOverview) =>
  o.paused || o.open >= o.max_open || o.last_24h >= o.max_per_day || o.usd_last_24h >= o.max_usd_per_day

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const grew = (cur: Partial<DispatcherUsage> | null, prev: unknown, k: keyof DispatcherUsage) =>
  Math.max(0, num(cur?.[k]) - num((prev as Partial<DispatcherUsage> | null)?.[k]))

async function tokenAgentId(): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { name: TOKEN_AGENT }, select: { id: true } })
  if (!agent) console.warn(`[self-improvement] agent ${TOKEN_AGENT} not found; dispatcher token usage is not recorded yet`)
  return agent?.id ?? null
}

/** Records the usage growth since the Bug's stored usage. Returns false when it could not be recorded. */
async function recordUsageDelta(bug: Bug, usage: DispatcherUsage | null): Promise<boolean> {
  const input = grew(usage, bug.fixUsage, 'input_tokens') + grew(usage, bug.fixUsage, 'cache_creation_input_tokens') + grew(usage, bug.fixUsage, 'cache_read_input_tokens')
  const output = grew(usage, bug.fixUsage, 'output_tokens')
  if (input === 0 && output === 0) return true
  const agentId = await tokenAgentId()
  if (!agentId) return false
  await recordTokenUsage(agentId, null, input, output, 'dispatcher')
  return true
}

const validDate = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? new Date() : d }

async function syncRequest(bug: Bug, r: DispatcherRequest): Promise<void> {
  const state = r.gate?.state ?? r.state
  const recorded = await recordUsageDelta(bug, r.usage)
  // fixRequestRef/fixRequestedAt also repair a Bug whose request was accepted but never stored.
  const data: Prisma.BugUpdateInput = { fixRequestRef: bug.id, fixRequestedAt: bug.fixRequestedAt ?? validDate(r.created), fixState: state, fixPrUrl: r.pr_url ?? bug.fixPrUrl, fixTaskId: r.task_id, fixBranch: r.branch }
  if (recorded && r.usage) data.fixUsage = r.usage as unknown as Prisma.InputJsonValue
  if (state === 'merged' && bug.fixState !== 'merged' && bug.status !== 'closed') {
    const at = new Date().toISOString()
    const note = { ref: `fix:${r.task_id}`, at, excerpt: '', note: `fix merged${r.pr_url ? `: ${r.pr_url}` : ''}; resolved until the signal comes back` }
    data.status = 'resolved'
    data.evidence = [note, ...(Array.isArray(bug.evidence) ? bug.evidence : [])] as unknown as Prisma.InputJsonValue
  }
  await prisma.bug.update({ where: { id: bug.id }, data })
}

function requestBody(bug: Bug) {
  const entries = (Array.isArray(bug.evidence) ? bug.evidence : []) as Array<{ ref?: string; at?: string; excerpt?: string; note?: string }>
  const evidence = entries.map(e => `[${e.at ?? ''}] ${e.ref ?? ''}${e.note ? ` (${e.note})` : ''}\n${e.excerpt ?? ''}`).join('\n\n')
  const problem = `${bug.description ?? ''}\n\nArea: ${bug.area ?? 'unknown'}\nSeverity: ${bug.severity}\nOccurrences: ${bug.occurrences}`
  return {
    ref: bug.id,
    title: redact(bug.title).slice(0, 120),
    problem: redact(problem).slice(0, MAX_PROBLEM),
    evidence: redact(evidence).slice(0, MAX_EVIDENCE_TEXT),
  }
}

async function sendOne(now: Date): Promise<string | null> {
  const bug = await prisma.bug.findFirst({
    where: {
      source: 'self-diagnosis', status: 'open', fixRequestRef: null, lastSeenAt: { gte: new Date(now.getTime() - DAY_MS) },
      OR: [{ severity: { in: ['high', 'critical'] } }, { severity: 'medium', occurrences: { gte: 3 } }],
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!bug) return null
  const res = await createRequest(requestBody(bug))
  const base = { fixRequestRef: bug.id, fixRequestedAt: now }
  if (res.ok) {
    const { task_id, branch } = res.request
    await prisma.bug.update({
      where: { id: bug.id },
      data: { ...base, fixTaskId: task_id, fixBranch: branch, fixState: res.outcome === 'accepted' ? res.request.state : 'requested', ...(res.outcome === 'duplicate' && res.request.pr_url ? { fixPrUrl: res.request.pr_url } : {}) },
    })
    return bug.id
  }
  // Invalid for good: mark it so the same Bug does not block the queue every run.
  if (res.reason === 'invalid') await prisma.bug.update({ where: { id: bug.id }, data: { ...base, fixState: 'rejected' } })
  console.warn(`[self-improvement] request for ${bug.id} not sent: ${res.reason}${res.status ? ` (HTTP ${res.status})` : ''}`)
  return null
}

export async function runSelfImprovement(now = new Date()): Promise<SelfImprovementResult> {
  if (!isSelfImprovementOn()) return { skipped: 'off', synced: 0, sent: null }
  const listed = await listRequests()
  if (!listed.ok) {
    console.warn(`[self-improvement] dispatcher not read: ${listed.reason}`)
    return { skipped: listed.reason, synced: 0, sent: null }
  }
  const { overview } = listed
  const bugs = await prisma.bug.findMany({ where: { source: 'self-diagnosis', id: { in: overview.requests.map(r => r.ref) } } })
  const byRef = new Map(bugs.map(b => [b.id, b]))
  let synced = 0
  for (const r of overview.requests) {
    const bug = byRef.get(r.ref)
    if (!bug) continue
    try {
      await syncRequest(bug, r)
      synced++
    } catch (e) {
      console.error(`[self-improvement] could not sync ${bug.id}:`, e)
    }
  }
  if (limitReached(overview)) return { skipped: overview.paused ? 'paused' : 'limit', synced, sent: null }
  return { synced, sent: await sendOne(now) }
}
