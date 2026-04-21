import { prisma } from '@/lib/db'
import { randomBytes } from 'crypto'

export type JobLogger = (msg: string) => Promise<void>

export async function startJob(
  type: string,
  title: string,
  opts: { environmentId?: string; metadata?: Record<string, unknown> },
  fn: (log: JobLogger) => Promise<void>,
): Promise<string> {
  const id = randomBytes(8).toString('hex')

  await prisma.backgroundJob.create({
    data: {
      id,
      type,
      title,
      status: 'queued',
      environmentId: opts.environmentId ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: (opts.metadata ?? undefined) as any,
    },
  })

  // Fire and forget — runs async in Node.js event loop
  setImmediate(() => {
    runJob(id, fn).catch(console.error)
  })

  return id
}

async function runJob(id: string, fn: (log: JobLogger) => Promise<void>): Promise<void> {
  const appendLog: JobLogger = async (msg: string) => {
    console.log(`[job:${id}]`, msg)
    await prisma.backgroundJob.update({
      where: { id },
      data: { logs: { push: msg }, updatedAt: new Date() },
    })
  }

  try {
    await prisma.backgroundJob.update({
      where: { id },
      data: { status: 'running', updatedAt: new Date() },
    })
    await fn(appendLog)
    await prisma.backgroundJob.update({
      where: { id },
      data: { status: 'completed', completedAt: new Date(), updatedAt: new Date() },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await appendLog(`Bootstrap failed: ${msg}`)
    await prisma.backgroundJob.update({
      where: { id },
      data: { status: 'failed', completedAt: new Date(), updatedAt: new Date() },
    })
  }
}

/** On server startup, mark any stale 'running' / 'queued' jobs as failed */
export async function recoverStalledJobs(): Promise<void> {
  const stale = await prisma.backgroundJob.findMany({
    where: { status: { in: ['queued', 'running'] } },
  })
  if (!stale.length) return

  await prisma.backgroundJob.updateMany({
    where: { id: { in: stale.map(j => j.id) } },
    data: { status: 'failed', completedAt: new Date(), updatedAt: new Date() },
  })

  for (const j of stale) {
    await prisma.backgroundJob.update({
      where: { id: j.id },
      data: { logs: { push: 'Server restarted — job interrupted.' } },
    })
  }

  console.log(`[job-runner] Marked ${stale.length} stale job(s) as failed`)
}
