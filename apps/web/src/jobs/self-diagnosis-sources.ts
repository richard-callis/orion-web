/**
 * Signal sources for self-diagnosis. Each returns the faults it sees; add a
 * source (e.g. failed deploys) by writing one more function and listing it in
 * SIGNAL_SOURCES.
 */
import { prisma } from '@/lib/db'
import { computeSourceStatus } from '@/lib/security/source-health-utils'
import { makeSignal, type Signal } from './self-diagnosis-text'

export const MAX_SIGNALS = 500

/** `truncated`: the source had more than MAX_SIGNALS rows in the window; the newest were left for the next run. */
export interface SourceResult { signals: Signal[]; truncated: boolean }
export type SignalSource = (since: Date, until: Date) => Promise<SourceResult>

/** Security sources that only report when an event arrives: silence is normal, not a fault. */
const EVENT_DRIVEN = new Set(['crowdsec', 'wazuh', 'gateway_audit'])

const LOG_LINES = 5

/** BackgroundJob rows that ended failed in the window. */
export const failedBackgroundJobs: SignalSource = async (since, until) => {
  const rows = await prisma.backgroundJob.findMany({
    // completedAt, not updatedAt: archiving a job bumps updatedAt and must not bring it back.
    where: { status: 'failed', completedAt: { gte: since, lte: until } },
    orderBy: { completedAt: 'asc' },
    take: MAX_SIGNALS + 1,
  })
  const truncated = rows.length > MAX_SIGNALS
  const signals = rows.slice(0, MAX_SIGNALS).map(r => {
    const tail = r.logs.slice(-LOG_LINES)
    return makeSignal({
      kind: `background-job:${r.type}`, area: r.type, ref: `background-job:${r.id}`,
      at: r.completedAt ?? r.updatedAt, windowed: true,
      text: tail.at(-1) ?? r.title,
      excerpt: `${r.title}\n${tail.join('\n')}`,
    })
  })
  return { signals, truncated }
}

/** JobRun rows (scheduled tasks, webhooks, system jobs) that ended failed in the window. */
export const failedJobRuns: SignalSource = async (since, until) => {
  const rows = await prisma.jobRun.findMany({
    where: { status: 'failed', finishedAt: { gte: since, lte: until } },
    orderBy: { finishedAt: 'asc' },
    take: MAX_SIGNALS + 1,
  })
  const truncated = rows.length > MAX_SIGNALS
  const signals = rows.slice(0, MAX_SIGNALS).map(r => makeSignal({
    kind: `job-run:${r.source}`, area: r.sourceName, ref: `job-run:${r.id}`,
    at: r.finishedAt ?? r.startedAt, windowed: true,
    text: r.errorMessage ?? `${r.sourceName} failed`,
    excerpt: `${r.sourceName}: ${r.errorMessage ?? 'failed without an error message'}`,
  }))
  return { signals, truncated }
}

/**
 * Heartbeat security sources (global and per environment) that are down (silent
 * for more than twice staleAfterMs). One signal per source name, listing the
 * environments; the ref pins the outage by the oldest lastSeenAt.
 */
export const staleSources: SignalSource = async (_since, until) => {
  const [global, perEnv] = await Promise.all([
    prisma.sourceHealth.findMany({ where: { lastSeenAt: { not: null } } }),
    prisma.environmentSourceHealth.findMany({ where: { lastSeenAt: { not: null } } }),
  ])
  const rows = [
    ...global.map(r => ({ ...r, env: r.environmentId ?? 'global' })),
    ...perEnv.map(r => ({ ...r, env: r.environmentId })),
  ].filter(r => r.lastSeenAt && !EVENT_DRIVEN.has(r.source)
    && computeSourceStatus(r.lastSeenAt.getTime(), until.getTime(), r.staleAfterMs) === 'down')
  const bySource = new Map<string, typeof rows>()
  for (const r of rows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r])
  const signals = [...bySource].map(([source, group]) => {
    const oldest = group.reduce((a, b) => (b.lastSeenAt! < a ? b.lastSeenAt! : a), group[0].lastSeenAt!)
    return makeSignal({
      kind: `stale-source:${source}`, area: source, ref: `stale:${source}:${oldest.toISOString()}`,
      // Detection time, so the evidence shows when we noticed; the ref pins the outage.
      at: until, windowed: false, high: true,
      text: `Security source ${source} is stale`,
      excerpt: group.map(r => `${source} (environment ${r.env}) last seen ${r.lastSeenAt!.toISOString()}; stale after ${r.staleAfterMs} ms`).join('\n'),
    })
  })
  return { signals, truncated: false }
}

export const SIGNAL_SOURCES: Array<{ name: string; windowed: boolean; read: SignalSource }> = [
  { name: 'failedBackgroundJobs', windowed: true, read: failedBackgroundJobs },
  { name: 'failedJobRuns', windowed: true, read: failedJobRuns },
  { name: 'staleSources', windowed: false, read: staleSources },
]
