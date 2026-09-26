import { prisma } from '@/lib/db'
import { randomBytes } from 'crypto'
import { hostname } from 'os'

export type JobLogger = (msg: string) => Promise<void>

/** Identifies the process running a job (BackgroundJob.ownerId). */
export const JOB_OWNER_ID = `${hostname()}:${process.pid}`

/** How often a running job's heartbeat is bumped. */
const JOB_HEARTBEAT_INTERVAL_MS = 30_000

/** A queued/running job with no heartbeat for this long is treated as orphaned. */
export const JOB_HEARTBEAT_STALE_MS = 2 * 60_000

export interface StartJobOptions {
  environmentId?: string
  metadata?: Record<string, unknown>
  /**
   * Idempotency key (e.g. "security-retention-daily:2026-09-26"). When set,
   * only one job with this key can ever be created; see startJobOnce().
   */
  dedupeKey?: string
}

export async function startJob(
  type: string,
  title: string,
  opts: StartJobOptions,
  fn: (log: JobLogger) => Promise<void>,
): Promise<string> {
  const id = randomBytes(8).toString('hex')
  const now = new Date()

  await prisma.backgroundJob.create({
    data: {
      id,
      type,
      title,
      status: 'queued',
      environmentId: opts.environmentId ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: (opts.metadata ?? undefined) as any,
      ownerId: JOB_OWNER_ID,
      heartbeatAt: now,
      dedupeKey: opts.dedupeKey ?? null,
    },
  })

  // Fire and forget — runs async in Node.js event loop
  setImmediate(() => {
    runJob(id, type, fn).catch(e => console.error(`[job:${id}] runner crashed:`, e))
  })

  return id
}

/** UTC calendar day, e.g. "2026-09-26" — dedupe period for daily jobs. */
export function utcDateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

/** Fixed-width time bucket index — dedupe period for sub-daily jobs. */
export function periodKey(periodMs: number, d: Date = new Date()): string {
  return String(Math.floor(d.getTime() / periodMs))
}

/**
 * Start a job at most once per `dedupeKey`, across restarts and replicas.
 * Returns the job id, or null if a job with that key already exists.
 */
export async function startJobOnce(
  type: string,
  title: string,
  dedupeKey: string,
  opts: Omit<StartJobOptions, 'dedupeKey'>,
  fn: (log: JobLogger) => Promise<void>,
): Promise<string | null> {
  try {
    return await startJob(type, title, { ...opts, dedupeKey }, fn)
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') return null // already created for this period
    throw e
  }
}

async function runJob(id: string, type: string, fn: (log: JobLogger) => Promise<void>): Promise<void> {
  const appendLog: JobLogger = async (msg: string) => {
    console.log(`[job:${id}]`, msg)
    await prisma.backgroundJob.update({
      where: { id },
      data: { logs: { push: msg }, updatedAt: new Date(), heartbeatAt: new Date() },
    })
  }

  const heartbeat = setInterval(() => {
    prisma.backgroundJob.updateMany({
      where: { id, status: { in: ['queued', 'running'] } },
      data:  { heartbeatAt: new Date() },
    }).catch(e => console.error(`[job:${id}] heartbeat failed:`, e))
  }, JOB_HEARTBEAT_INTERVAL_MS)

  try {
    await prisma.backgroundJob.update({
      where: { id },
      data: { status: 'running', updatedAt: new Date(), heartbeatAt: new Date() },
    })
    await fn(appendLog)
    await prisma.backgroundJob.update({
      where: { id },
      data: { status: 'completed', completedAt: new Date(), updatedAt: new Date() },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[job:${id}] ${type} failed:`, msg)
    // Record the failure in a single write that doesn't depend on appendLog —
    // if the log write threw (e.g. DB blip), the job must still leave 'running'.
    await prisma.backgroundJob.update({
      where: { id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        updatedAt: new Date(),
        logs: { push: `${type} failed: ${msg}` },
      },
    }).catch(async e => {
      console.error(`[job:${id}] could not record failure with log line:`, e)
      await prisma.backgroundJob.updateMany({
        where: { id },
        data: { status: 'failed', completedAt: new Date(), updatedAt: new Date() },
      }).catch(e2 => console.error(`[job:${id}] could not mark job failed:`, e2))
    })
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * Mark queued/running jobs whose owner has stopped heartbeating as failed.
 * Safe to call from any process at any time: jobs owned by a live process keep
 * a fresh heartbeat and are left alone (previously every web boot failed ALL
 * running jobs, including ones owned by another live replica).
 */
export async function recoverStalledJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - JOB_HEARTBEAT_STALE_MS)
  const stale = await prisma.backgroundJob.findMany({
    where: {
      status: { in: ['queued', 'running'] },
      OR: [
        { heartbeatAt: { lt: cutoff } },
        // Rows from before heartbeats existed
        { heartbeatAt: null, updatedAt: { lt: cutoff } },
      ],
    },
    select: { id: true, ownerId: true },
    take: 500,
  })
  if (!stale.length) return

  let recovered = 0
  for (const j of stale) {
    // Conditional on still being stale, so a job that resumed heartbeating in
    // the meantime is not clobbered.
    const res = await prisma.backgroundJob.updateMany({
      where: {
        id: j.id,
        status: { in: ['queued', 'running'] },
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null }],
      },
      data: { status: 'failed', completedAt: new Date(), updatedAt: new Date() },
    })
    if (res.count === 0) continue
    recovered++
    await prisma.backgroundJob.update({
      where: { id: j.id },
      data: { logs: { push: `Job interrupted — owner ${j.ownerId ?? 'unknown'} stopped responding.` } },
    }).catch(() => {})
  }

  if (recovered > 0) console.log(`[job-runner] Marked ${recovered} orphaned job(s) as failed`)
}
