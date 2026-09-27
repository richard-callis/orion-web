import { prisma } from '@/lib/db'
import { log, err } from './log'

/**
 * Poll all in-flight federated tasks for completion.
 * Fetches status from each spoke and marks the local task done/failed to match.
 */
const FED_POLL_MAX_FAILURES = 5          // give up after 5 consecutive failures
const FED_POLL_MAX_AGE_MS   = 24 * 60 * 60 * 1000  // abandon dispatches older than 24h

export async function pollFederatedTasks(): Promise<void> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - FED_POLL_MAX_AGE_MS)

  const dispatches = await prisma.federatedDispatch.findMany({
    where: { status: { in: ['dispatched', 'acknowledged'] } },
    select: { id: true, taskId: true, spokeUrl: true, status: true, failCount: true, dispatchedAt: true },
  })
  if (dispatches.length === 0) return

  const token = process.env.ORION_GATEWAY_TOKEN ?? ''

  await Promise.all(dispatches.map(async (dispatch) => {
    // Abandon dispatches that are too old or have failed too many times
    if (dispatch.dispatchedAt < cutoff || dispatch.failCount >= FED_POLL_MAX_FAILURES) {
      await prisma.$transaction([
        prisma.task.update({ where: { id: dispatch.taskId }, data: { status: 'failed' } }),
        prisma.federatedDispatch.update({ where: { id: dispatch.id }, data: { status: 'failed' } }),
      ])
      err(`Federated task ${dispatch.taskId} abandoned — ${dispatch.failCount >= FED_POLL_MAX_FAILURES ? `${dispatch.failCount} consecutive failures` : 'dispatch age exceeded 24h'}`)
      return
    }

    try {
      const res = await fetch(`${dispatch.spokeUrl}/api/federation/tasks/${dispatch.taskId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })

      if (!res.ok) {
        await prisma.federatedDispatch.update({
          where: { id: dispatch.id },
          data: { failCount: { increment: 1 }, lastPolledAt: now },
        })
        return
      }

      const data = (await res.json()) as { status: string }
      const spokeStatus = data.status

      if (spokeStatus === 'done' || spokeStatus === 'failed') {
        await prisma.$transaction([
          prisma.task.update({ where: { id: dispatch.taskId }, data: { status: spokeStatus } }),
          prisma.federatedDispatch.update({ where: { id: dispatch.id }, data: { status: 'completed', completedAt: now, failCount: 0, lastPolledAt: now } }),
        ])
        log(`Federated task ${dispatch.taskId} completed on spoke with status: ${spokeStatus}`)
      } else if (spokeStatus === 'in_progress' && dispatch.status === 'dispatched') {
        await prisma.federatedDispatch.update({ where: { id: dispatch.id }, data: { status: 'acknowledged', acknowledgedAt: now, failCount: 0, lastPolledAt: now } })
      } else {
        await prisma.federatedDispatch.update({ where: { id: dispatch.id }, data: { failCount: 0, lastPolledAt: now } })
      }
    } catch (e) {
      err(`Failed to poll federated task ${dispatch.taskId} at ${dispatch.spokeUrl}: ${e instanceof Error ? e.message : String(e)}`)
      await prisma.federatedDispatch.update({
        where: { id: dispatch.id },
        data: { failCount: { increment: 1 }, lastPolledAt: now },
      }).catch(() => {})
    }
  }))
}
