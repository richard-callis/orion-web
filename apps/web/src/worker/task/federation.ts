import { prisma } from '@/lib/db'
import { shouldFederate, dispatchToSpoke } from '@/lib/federation'
import { log, err } from '../log'
import { freshTaskMetadata, logTaskEvent } from '../db-helpers'
import type { PreparedTask } from './types'

/**
 * Dispatch the task to a federated spoke when it should run there.
 * Returns true if dispatched (the spoke now owns it); false to run locally.
 * Failures are non-fatal and fall back to running locally.
 */
export async function maybeFederate(p: PreparedTask): Promise<boolean> {
  const { taskId, task, agent, taskMeta } = p
  try {
    const fed = await shouldFederate(taskId)
    if (fed.federate && fed.spokeUrl && fed.token) {
      const dispatched = await dispatchToSpoke(taskId, fed.spokeUrl, fed.token)
      if (dispatched) {
        // BUG 1 fix: set status to 'in_progress' in the SAME update as
        // metadata.federated so pollOnce's `status: 'pending'` query can never
        // re-pick this task up on the next poll cycle (~15s later).
        // BUG 6 fix: taskMeta was snapshotted before the network round-trip to
        // the spoke in dispatchToSpoke() above — re-fetch immediately before
        // this whole-object write.
        const currentMeta = await freshTaskMetadata(taskId, taskMeta)
        await prisma.task.update({
          where: { id: taskId },
          data: {
            status: 'in_progress',
            metadata: {
              ...(currentMeta as object),
              federated: true,
              spokeUrl: fed.spokeUrl,
            } as object,
          },
        })
        await logTaskEvent(taskId, 'federated',
          `Task dispatched to spoke at ${fed.spokeUrl} for execution`, agent.id)
        log(`Task "${task.title}" (${taskId}) federated to spoke ${fed.spokeUrl}`)
        return true
      }
      log(`Federation dispatch for task ${taskId} to ${fed.spokeUrl} failed — running locally`)
    }
  } catch (fedErr) {
    err(`Federation check for task ${taskId} failed (non-fatal): ${fedErr instanceof Error ? fedErr.message : String(fedErr)}`)
  }
  return false
}
