/**
 * Signal sources for self-diagnosis. Each returns the faults it sees; add a
 * source (e.g. failed deploys) by writing one more function and listing it in
 * SIGNAL_SOURCES.
 */
import { prisma } from '@/lib/db'
import { makeSignal, type Signal } from './self-diagnosis-text'

export const MAX_SIGNALS = 500

export type SignalSource = (since: Date, until: Date) => Promise<Signal[]>

const LOG_LINES = 5

/** BackgroundJob rows that ended failed in the window. */
export const failedBackgroundJobs: SignalSource = async (since, until) => {
  const rows = await prisma.backgroundJob.findMany({
    where: { status: 'failed', updatedAt: { gte: since, lte: until } },
    orderBy: { updatedAt: 'asc' },
    take: MAX_SIGNALS,
  })
  return rows.map(r => {
    const tail = r.logs.slice(-LOG_LINES)
    return makeSignal({
      kind: `background-job:${r.type}`, area: r.type, ref: `background-job:${r.id}`,
      at: r.completedAt ?? r.updatedAt, windowed: true,
      text: tail.at(-1) ?? r.title,
      excerpt: `${r.title}\n${tail.join('\n')}`,
    })
  })
}

/** JobRun rows (scheduled tasks, webhooks, system jobs) that ended failed in the window. */
export const failedJobRuns: SignalSource = async (since, until) => {
  const rows = await prisma.jobRun.findMany({
    where: { status: 'failed', finishedAt: { gte: since, lte: until } },
    orderBy: { finishedAt: 'asc' },
    take: MAX_SIGNALS,
  })
  return rows.map(r => makeSignal({
    kind: `job-run:${r.source}`, area: r.sourceName, ref: `job-run:${r.id}`,
    at: r.finishedAt ?? r.startedAt, windowed: true,
    text: r.errorMessage ?? `${r.sourceName} failed`,
    excerpt: `${r.sourceName}: ${r.errorMessage ?? 'failed without an error message'}`,
  }))
}

/** Security sources (global and per environment) that stopped reporting. One signal per source row; rows of one source share a fingerprint. */
export const staleSources: SignalSource = async (_since, until) => {
  const [global, perEnv] = await Promise.all([
    prisma.sourceHealth.findMany({ where: { lastSeenAt: { not: null } } }),
    prisma.environmentSourceHealth.findMany({ where: { lastSeenAt: { not: null } } }),
  ])
  const rows = [
    ...global.map(r => ({ ...r, env: r.environmentId ?? 'global' })),
    ...perEnv.map(r => ({ ...r, env: r.environmentId })),
  ]
  return rows
    .filter(r => r.lastSeenAt && until.getTime() - r.lastSeenAt.getTime() > r.staleAfterMs)
    .map(r => makeSignal({
      kind: `stale-source:${r.source}`, area: r.source, ref: `stale:${r.id}:${r.lastSeenAt!.toISOString()}`,
      // Detection time, so the evidence shows when we noticed; the ref pins the outage.
      at: until, windowed: false, high: true,
      text: `Security source ${r.source} is stale`,
      excerpt: `${r.source} (environment ${r.env}) last seen ${r.lastSeenAt!.toISOString()}; stale after ${r.staleAfterMs} ms`,
    }))
}

export const SIGNAL_SOURCES: SignalSource[] = [failedBackgroundJobs, failedJobRuns, staleSources]
