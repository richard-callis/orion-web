/**
 * Federation lib — hub/spoke multi-cluster task routing.
 *
 * shouldFederate(): decide whether a task should be dispatched to a spoke.
 * dispatchToSpoke(): POST the task to a spoke and record a FederatedDispatch row.
 */

import { prisma } from './db'
import { logAudit } from './audit'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FederationDecision {
  federate: boolean
  spokeUrl?: string
  token?: string
}

interface SpokeStatus {
  runningTasks: number
  pendingTasks: number
  agentCount: number
  environmentId: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Fetch status from a spoke's /api/federation/status endpoint.
 * Returns null on any network or auth error so callers can skip unreachable spokes.
 */
async function fetchSpokeStatus(spokeUrl: string, token: string): Promise<SpokeStatus | null> {
  const { isPrivateUrl } = await import('./ssrf-guard')
  if (await isPrivateUrl(spokeUrl)) {
    void logAudit({ action: 'ssrf_blocked', target: spokeUrl, detail: { url: spokeUrl, context: 'federation' }, userId: 'SYSTEM' })
    return null
  }
  try {
    const res = await fetch(`${spokeUrl}/api/federation/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    return (await res.json()) as SpokeStatus
  } catch {
    return null
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Decide whether a task should be federated to a spoke.
 *
 * Rules:
 * - If the task's agent has no linked environment, run locally.
 * - If the environment role is 'hub': probe all spoke environments for load.
 *   Route to the least-loaded spoke that is reachable.
 * - If the environment role is 'spoke': this task was already dispatched here — run locally.
 * - If standalone (no role): run locally.
 */
export async function shouldFederate(taskId: string): Promise<FederationDecision> {
  // Load task with agent, then find agent's environments
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { assignedAgent: true },
  })
  if (!task?.assignedAgent) return { federate: false }

  const agentEnvs = await prisma.agentEnvironment.findMany({
    where: { agentId: task.assignedAgent },
    include: {
      environment: {
        select: {
          id: true,
          federationRole: true,
          federationToken: true,
          spokeUrl: true,
          hubUrl: true,
        },
      },
    },
  })

  // Find the first hub environment this agent belongs to
  const hubEnv = agentEnvs.find(ae => ae.environment.federationRole === 'hub')?.environment
  if (!hubEnv || !hubEnv.federationToken) return { federate: false }

  // Find all spoke environments
  const spokeEnvs = await prisma.environment.findMany({
    where: { federationRole: 'spoke', spokeUrl: { not: null } },
    select: { id: true, spokeUrl: true, federationToken: true },
  })
  if (spokeEnvs.length === 0) return { federate: false }

  // Probe each spoke for load and pick the least-loaded reachable one
  const results: Array<{ spokeUrl: string; load: number }> = []

  await Promise.all(
    spokeEnvs.map(async (spoke) => {
      if (!spoke.spokeUrl || !spoke.federationToken) return
      const status = await fetchSpokeStatus(spoke.spokeUrl, spoke.federationToken)
      if (!status) return
      results.push({
        spokeUrl: spoke.spokeUrl,
        load: status.runningTasks + status.pendingTasks,
      })
    }),
  )

  if (results.length === 0) return { federate: false }

  // Also check local hub load for comparison
  const localRunning = await prisma.task.count({ where: { status: 'in_progress' } })
  const localPending  = await prisma.task.count({ where: { status: 'pending' } })
  const localLoad = localRunning + localPending

  results.sort((a, b) => a.load - b.load)
  const best = results[0]

  // Only federate if the best spoke is less loaded than the local hub
  if (best.load >= localLoad) return { federate: false }

  return {
    federate: true,
    spokeUrl: best.spokeUrl,
    token: hubEnv.federationToken,
  }
}

/**
 * Dispatch a task to a spoke instance.
 * - POSTs to {spokeUrl}/api/federation/tasks
 * - Records a FederatedDispatch row
 * - Returns true on success, false on failure
 */
export async function dispatchToSpoke(
  taskId: string,
  spokeUrl: string,
  token: string,
): Promise<boolean> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      description: true,
      assignedAgent: true,
      metadata: true,
    },
  })
  if (!task) return false

  // Find the spoke environment id from spokeUrl
  const spokeEnv = await prisma.environment.findFirst({
    where: { spokeUrl },
    select: { id: true },
  })
  const targetEnvId = spokeEnv?.id ?? 'unknown'

  if (process.env.NODE_ENV === 'production') {
    if (spokeUrl.startsWith('http://')) {
      throw new Error(`Federation URL must use HTTPS in production: ${spokeUrl}`)
    }
  }

  try {
    const { isPrivateUrl } = await import('./ssrf-guard')
    if (await isPrivateUrl(spokeUrl)) {
      void logAudit({ action: 'ssrf_blocked', target: spokeUrl, detail: { url: spokeUrl, context: 'federation' }, userId: 'SYSTEM' })
      return false
    }
    const res = await fetch(`${spokeUrl}/api/federation/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        taskId: task.id,
        title: task.title,
        description: task.description,
        agentId: task.assignedAgent,
        metadata: task.metadata,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) return false

    // Record FederatedDispatch
    await prisma.federatedDispatch.create({
      data: {
        taskId,
        targetEnvId,
        spokeUrl,
        status: 'dispatched',
      },
    })

    return true
  } catch {
    return false
  }
}
