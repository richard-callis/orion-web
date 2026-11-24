/**
 * Self-improvement: asks the agent dispatcher to fix ORION's own self-diagnosed
 * bugs (see lib/dispatcher-requests.ts). ORION never writes code itself; the
 * dispatcher runs a coding agent that opens a PR the owner reviews.
 *
 * Every 15 minutes (worker scheduler); does nothing unless the dispatcher client
 * is configured AND ORION_SELF_IMPROVEMENT=on (ORION's own switch; the dispatcher
 * has another). Each run:
 *  1. reads the dispatcher's requests (if that fails, nothing else happens);
 *  2. syncs the requests of the configured repo whose ref is a self-diagnosis Bug
 *     id into the Bug's fix* fields (state and PR url from the newest request of
 *     that ref), records the growth of every request's usage, and resolves the
 *     Bug when the newest request's gate merged. A Bug is only written when
 *     something changed, so its updatedAt (and its place in the Bugs list) holds;
 *  3. unless the dispatcher is paused or a limit is reached, sends at most ONE
 *     request: the oldest open self-diagnosis Bug with no request yet, severity
 *     high/critical (or medium with 3+ occurrences), seen in the last 24 h. A Bug
 *     whose send failed with an error waits an hour behind the others.
 *
 * A Bug is requested once; closed, stuck, superseded or regressed requests stay
 * with the owner. Resolved-on-merge is the only verification: self-diagnosis
 * reopens the Bug ("regressed") if the same fault shows up after the fix is
 * deployed (it allows a 30 min deploy grace after the "fix:" note).
 *
 * Token accounting: usage deltas (not totals) go to AgentTokenUsage via
 * recordTokenUsage under the Alpha system agent (modelId "dispatcher"). Alpha is
 * the coordinator that hands work to other agents, and a new agent would need a
 * seed entry with prompts. Input = input + cache creation + cache read tokens.
 * The baseline is kept per dispatcher task in Bug.fixUsage ({ [task_id]: usage }),
 * so several requests for one ref are each counted once. Usage is recorded before
 * the stored baseline moves on, so a failure in between can double-count one
 * delta but never lose it. If Alpha does not exist yet, nothing is recorded and
 * the baseline stays put, so it is caught up later.
 * Note: checkAgentBudget (lib/token-budget.ts) sums all of an agent's rows, so
 * these rows count towards Alpha's tokenBudgetDay / tokenBudgetMonth, if the
 * owner set them; a large coding task (cache reads count as input) can use them up.
 * Rows for "dispatcher" have no ExternalModel price, so /api/cost/summary shows no
 * cost for them; the dispatcher's own cost_usd estimate is kept in Bug.fixUsage
 * (a subscription estimate, not a bill).
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { recordTokenUsage } from '@/lib/token-budget'
import {
  createRequest, dispatcherConfig, isDispatcherConfigured, listRequests,
  type DispatcherOverview, type DispatcherRequest, type DispatcherUsage,
} from '@/lib/dispatcher-requests'
import { redact } from './self-diagnosis-text'

const DAY_MS = 24 * 60 * 60 * 1000
const RETRY_AFTER_ERROR_MS = 60 * 60 * 1000
const TOKEN_AGENT = 'Alpha'
const MAX_PROBLEM = 8000
const MAX_EVIDENCE_TEXT = 20000
const ENDED = ['closed', 'stuck', 'superseded']

type Bug = Prisma.BugGetPayload<object>
type AgentId = () => Promise<string | null>
export interface SelfImprovementResult { skipped?: string; synced: number; sent: string | null }

export const isSelfImprovementOn = () => process.env.ORION_SELF_IMPROVEMENT === 'on' && isDispatcherConfigured()

let warnedNotConfigured = false

// A missing or non-numeric figure counts as a limit reached.
const atLimit = (used: unknown, max: unknown) => !(typeof used === 'number' && Number.isFinite(used) && typeof max === 'number' && Number.isFinite(max) && used < max)
const limitReached = (o: DispatcherOverview) =>
  o.paused || atLimit(o.open, o.max_open) || atLimit(o.last_24h, o.max_per_day) || atLimit(o.usd_last_24h, o.max_usd_per_day)

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const grew = (cur: Partial<DispatcherUsage> | null, prev: unknown, k: keyof DispatcherUsage) =>
  Math.max(0, num(cur?.[k]) - num((prev as Partial<DispatcherUsage> | null)?.[k]))

// Key order does not matter (a JSON column does not keep it), so equal values compare equal.
const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

const storedUsage = (bug: Bug): Record<string, unknown> =>
  bug.fixUsage && typeof bug.fixUsage === 'object' && !Array.isArray(bug.fixUsage) ? (bug.fixUsage as Record<string, unknown>) : {}

/** Looks the Alpha agent up once per run, only when there is something to record. */
function agentResolver(): AgentId {
  let found: Promise<string | null> | undefined
  return () => (found ??= prisma.agent.findUnique({ where: { name: TOKEN_AGENT }, select: { id: true } }).then(agent => {
    if (!agent) console.warn(`[self-improvement] agent ${TOKEN_AGENT} not found; dispatcher token usage is not recorded yet`)
    return agent?.id ?? null
  }))
}

/** Records the usage growth of every task of this Bug since its stored baseline. Returns false when it could not be recorded. */
async function recordUsageDelta(bug: Bug, requests: DispatcherRequest[], agentId: AgentId): Promise<boolean> {
  const prev = storedUsage(bug)
  let input = 0, output = 0
  for (const r of requests) {
    const before = prev[r.task_id]
    input += grew(r.usage, before, 'input_tokens') + grew(r.usage, before, 'cache_creation_input_tokens') + grew(r.usage, before, 'cache_read_input_tokens')
    output += grew(r.usage, before, 'output_tokens')
  }
  if (input === 0 && output === 0) return true
  const id = await agentId()
  if (!id) return false
  await recordTokenUsage(id, null, input, output, 'dispatcher')
  return true
}

const validDate = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? new Date() : d }
const createdAt = (r: DispatcherRequest) => { const t = Date.parse(r.created); return Number.isNaN(t) ? 0 : t }

/** Syncs one Bug from all dispatcher requests of its ref; writes only when something changed. */
async function syncBug(bug: Bug, requests: DispatcherRequest[], agentId: AgentId): Promise<void> {
  const newest = requests.reduce((a, b) => (createdAt(b) >= createdAt(a) ? b : a))
  const state = newest.gate?.state ?? newest.state
  const recorded = await recordUsageDelta(bug, requests, agentId)
  // fixRequestRef/fixRequestedAt also repair a Bug whose request was accepted but never stored.
  const next: Record<string, unknown> = { fixRequestRef: bug.id, fixRequestedAt: bug.fixRequestedAt ?? validDate(newest.created), fixState: state, fixPrUrl: newest.pr_url ?? bug.fixPrUrl, fixTaskId: newest.task_id, fixBranch: newest.branch }
  if (recorded) {
    const usage = { ...storedUsage(bug) }
    for (const r of requests) if (r.usage) usage[r.task_id] = r.usage
    next.fixUsage = usage
  }
  let dirty = Object.entries(next).some(([k, v]) => canon(v) !== canon(bug[k as keyof Bug]))
  if (ENDED.includes(state) && bug.fixState !== state) console.info(`[self-improvement] ${bug.id}: request ${newest.task_id} ended ${state}; not re-requested`)
  if (state === 'merged' && bug.fixState !== 'merged' && bug.status !== 'closed') {
    const at = new Date().toISOString()
    const note = { ref: `fix:${newest.task_id}`, at, excerpt: '', note: `fix merged${newest.pr_url ? `: ${newest.pr_url}` : ''}; resolved until the signal comes back` }
    next.status = 'resolved'
    next.evidence = [note, ...(Array.isArray(bug.evidence) ? bug.evidence : [])]
    dirty = true
    console.info(`[self-improvement] resolved ${bug.id}: fix merged${newest.pr_url ? ` ${newest.pr_url}` : ''}`)
  }
  if (dirty) await prisma.bug.update({ where: { id: bug.id }, data: next as Prisma.BugUpdateInput })
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
      AND: [
        { OR: [{ severity: { in: ['high', 'critical'] } }, { severity: 'medium', occurrences: { gte: 3 } }] },
        { OR: [{ fixRequestedAt: null }, { fixRequestedAt: { lt: new Date(now.getTime() - RETRY_AFTER_ERROR_MS) } }] },
      ],
    },
    orderBy: [{ fixRequestedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  })
  if (!bug) return null
  const res = await createRequest(requestBody(bug))
  if (res.ok) {
    const { task_id, branch } = res.request
    await prisma.bug.update({
      where: { id: bug.id },
      data: {
        fixRequestRef: bug.id, fixRequestedAt: now, fixTaskId: task_id, fixBranch: branch,
        fixState: res.outcome === 'accepted' ? (res.request.state || 'requested') : 'requested',
        ...(res.outcome === 'duplicate' && res.request.pr_url ? { fixPrUrl: res.request.pr_url } : {}),
      },
    })
    console.info(`[self-improvement] asked the dispatcher to fix ${bug.id} (${res.outcome}, task ${task_id})`)
    return bug.id
  }
  // A failed send goes behind the other Bugs for an hour, so it does not block the queue every run.
  if (res.reason === 'error') await prisma.bug.update({ where: { id: bug.id }, data: { fixRequestedAt: now } })
  console.warn(`[self-improvement] request for ${bug.id} not sent: ${res.reason}${res.status ? ` (HTTP ${res.status})` : ''}${res.detail ? `: ${res.detail}` : ''}`)
  return null
}

export async function runSelfImprovement(now = new Date()): Promise<SelfImprovementResult> {
  if (process.env.ORION_SELF_IMPROVEMENT !== 'on') return { skipped: 'off', synced: 0, sent: null }
  if (!isDispatcherConfigured()) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true
      console.warn('[self-improvement] ORION_SELF_IMPROVEMENT is on, but DISPATCHER_REQUESTS_URL, DISPATCHER_REQUESTS_TOKEN and DISPATCHER_REQUESTS_REPO must all be set')
    }
    return { skipped: 'off', synced: 0, sent: null }
  }
  const listed = await listRequests()
  if (!listed.ok) {
    console.warn(`[self-improvement] dispatcher not read: ${listed.reason}${listed.status ? ` (HTTP ${listed.status})` : ''}`)
    return { skipped: listed.reason, synced: 0, sent: null }
  }
  const { overview } = listed
  const repo = dispatcherConfig()?.repo
  const byRef = new Map<string, DispatcherRequest[]>()
  for (const r of overview.requests) if (r.repo === repo) byRef.set(r.ref, [...(byRef.get(r.ref) ?? []), r])
  const bugs = await prisma.bug.findMany({ where: { source: 'self-diagnosis', id: { in: [...byRef.keys()] } } })
  const agentId = agentResolver()
  let synced = 0
  for (const bug of bugs) {
    try {
      await syncBug(bug, byRef.get(bug.id)!, agentId)
      synced++
    } catch (e) {
      console.error(`[self-improvement] could not sync ${bug.id}:`, e)
    }
  }
  if (overview.configured === false) return { skipped: 'dispatcher_not_configured', synced, sent: null }
  if (limitReached(overview)) return { skipped: overview.paused ? 'paused' : 'limit', synced, sent: null }
  return { synced, sent: await sendOne(now) }
}
