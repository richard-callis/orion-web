/**
 * K8s events poller (Phase 2 PR8).
 *
 * Per environment of type="cluster", every 30s:
 *   - Read EnvironmentSourceHealth.lastWatermark (the K8s resourceVersion
 *     from the previous poll) for source="k8s_events"
 *   - Call the gateway's kubectl_get_events tool with that resourceVersion
 *   - On 410 Gone, full resync (empty resourceVersion)
 *   - Normalize each item via normalizeK8sEvent
 *   - Idempotent insert keyed on dedupKey (envId|uid|count)
 *   - Advance the watermark to the response resourceVersion
 *
 * Wires into worker.ts alongside the existing security correlator interval.
 */
import { prisma } from '@/lib/db'
import { GatewayClient } from '@/lib/agent-runner/gateway-client'
import { normalizeK8sEvent, type K8sEvent } from '@/lib/security/normalize/k8s-events'
import { normalizedEventSchema } from '@/lib/security/types'

export interface K8sPollResult {
  environmentId: string
  source: 'k8s_events'
  polledAt: Date
  eventsFound: number
  eventsInserted: number
  eventsSkipped: number
  resyncTriggered: boolean
  errors: string[]
  newWatermark: string | null
  durationMs: number
}

const STALE_AFTER_MS = 120_000 // 2 min — poller runs every 30s; 2min = 4x

/**
 * Run one poll cycle across all cluster environments.
 * Returns per-env results for observability.
 */
export async function runK8sPollerAll(): Promise<K8sPollResult[]> {
  const envs = await prisma.environment.findMany({
    where: { type: 'cluster', status: 'connected' },
    select: { id: true, gatewayUrl: true, gatewayToken: true },
  })
  return Promise.all(envs.map((env) => runK8sPoller(env)))
}

/**
 * Run one poll cycle for a single environment.
 *
 * Exported for testability and so callers can scope to a single env.
 */
export async function runK8sPoller(env: {
  id: string
  gatewayUrl: string | null
  gatewayToken: string | null
}): Promise<K8sPollResult> {
  const startTime = Date.now()
  const result: K8sPollResult = {
    environmentId: env.id,
    source: 'k8s_events',
    polledAt: new Date(startTime),
    eventsFound: 0,
    eventsInserted: 0,
    eventsSkipped: 0,
    resyncTriggered: false,
    errors: [],
    newWatermark: null,
    durationMs: 0,
  }

  if (!env.gatewayUrl) {
    result.errors.push('environment has no gatewayUrl')
    result.durationMs = Date.now() - startTime
    return result
  }

  const client = new GatewayClient(env.gatewayUrl, env.gatewayToken ?? '')

  // 1. Get the last watermark
  const health = await prisma.environmentSourceHealth.findUnique({
    where: {
      environmentId_source: { environmentId: env.id, source: 'k8s_events' },
    },
    select: { lastWatermark: true },
  })
  const resourceVersion = health?.lastWatermark ?? ''

  // 2. Call the gateway tool
  let raw: string
  try {
    raw = await client.executeTool('kubectl_get_events', { resourceVersion })
  } catch (err) {
    result.errors.push(`gateway call failed: ${err instanceof Error ? err.message : String(err)}`)
    result.durationMs = Date.now() - startTime
    return result
  }

  // 3. Detect 410 Gone (gateway tool returns {error:"gone",...} JSON in that case)
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    result.errors.push('gateway returned non-JSON response')
    result.durationMs = Date.now() - startTime
    return result
  }

  if (parsed?.error === 'gone') {
    // Full resync on next call — reset the watermark and bail out this cycle.
    result.resyncTriggered = true
    await prisma.environmentSourceHealth.upsert({
      where: {
        environmentId_source: { environmentId: env.id, source: 'k8s_events' },
      },
      update: { lastWatermark: null, lastSeenAt: new Date() },
      create: {
        environmentId: env.id,
        source: 'k8s_events',
        lastSeenAt: new Date(),
        lastWatermark: null,
        staleAfterMs: STALE_AFTER_MS,
      },
    })
    result.durationMs = Date.now() - startTime
    return result
  }

  // 4. Normalize + insert
  const items: K8sEvent[] = Array.isArray(parsed?.items) ? parsed.items : []
  result.eventsFound = items.length
  const responseRV: string | undefined =
    parsed?.metadata?.resourceVersion ??
    items[items.length - 1]?.metadata?.resourceVersion

  for (const item of items) {
    try {
      const event = normalizeK8sEvent(item, env.id)
      const validated = normalizedEventSchema.parse(event)

      const existing = await prisma.securityEvent.count({
        where: { dedupKey: validated.dedupKey, source: 'k8s_events' },
      })
      if (existing > 0) {
        result.eventsSkipped++
        continue
      }

      await prisma.securityEvent.create({
        data: {
          environmentId: env.id,
          type: validated.type,
          source: validated.source,
          severity: validated.severity,
          title: validated.title,
          description: validated.description ?? null,
          rawEvent: validated.rawEvent as any,
          dedupKey: validated.dedupKey,
          firstSeen: validated.timestamp ?? new Date(),
          lastSeen: validated.timestamp ?? new Date(),
        },
      })
      result.eventsInserted++
    } catch (err) {
      result.errors.push(
        `event normalize/insert failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // 5. Advance watermark — only persist a new RV if we have one from the response.
  //    Otherwise leave the prior watermark in place (matches the ELK poller
  //    pattern from Phase 1).
  if (responseRV) {
    result.newWatermark = responseRV
  }

  await prisma.environmentSourceHealth.upsert({
    where: {
      environmentId_source: { environmentId: env.id, source: 'k8s_events' },
    },
    update: {
      lastSeenAt: new Date(),
      ...(responseRV ? { lastWatermark: responseRV } : {}),
    },
    create: {
      environmentId: env.id,
      source: 'k8s_events',
      lastSeenAt: new Date(),
      lastWatermark: responseRV ?? null,
      staleAfterMs: STALE_AFTER_MS,
    },
  })

  result.durationMs = Date.now() - startTime
  return result
}
