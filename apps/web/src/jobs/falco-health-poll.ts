/**
 * Falco liveness poller.
 *
 * Falco's webhook path (apps/web/src/app/api/monitoring/security/webhooks/falco)
 * bumps EnvironmentSourceHealth.lastSeenAt whenever an alert arrives, but on a
 * quiet host Falco's stock rules may legitimately never fire — no attacks, no
 * alerts, which is correct IDS behavior. That silence is indistinguishable from
 * Falco's process having died or never started, since nothing else confirms the
 * process itself is still running and watching.
 *
 * Falco 0.44+ ships a built-in webserver module exposing GET /healthz (port 8765
 * by default) — the officially documented liveness/readiness mechanism. Polling
 * it directly avoids inventing a synthetic rule-based heartbeat that would have
 * to flow through the alert/SecurityEvent pipeline.
 *
 * Falco runs once, on the Orion host itself (type="localhost" Environment) —
 * see the webhook route's 'host' → localhost-environment resolution.
 *
 * Deliberately a DIFFERENT source key ("falco_process") than the webhook's
 * ("falco"). The webhook's EnvironmentSourceHealth row reflects the whole
 * delivery path (Falco rule fires -> Falcosidekick -> HMAC'd webhook POST);
 * this poller only confirms the Falco process itself answers /healthz. If
 * both bumped the same row, this poller would mask a broken delivery path
 * (wrong secret, Falcosidekick down, webhook rejecting) behind a process
 * that's merely alive — the exact kind of silent failure this file exists
 * to catch, just one hop further along.
 */
import { prisma } from '@/lib/db'

const FALCO_HEALTHZ_URL = process.env.FALCO_HEALTHZ_URL ?? 'http://falco:8765/healthz'
const FALCO_PROCESS_SOURCE = 'falco_process'
const FALCO_STALE_AFTER_MS = 300_000 // matches the webhook route's threshold
const HEALTHZ_TIMEOUT_MS = 5_000

export interface FalcoHealthPollResult {
  environmentId: string | null
  healthy: boolean
  error?: string
  durationMs: number
}

/**
 * Poll Falco's /healthz once and bump EnvironmentSourceHealth for the
 * Orion host environment on success. No-op (not an error) if no
 * localhost-type environment is registered yet.
 */
export async function runFalcoHealthPollAll(): Promise<FalcoHealthPollResult> {
  const startTime = Date.now()
  const hostEnv = await prisma.environment.findFirst({
    where: { type: 'localhost' },
    select: { id: true },
  })
  if (!hostEnv) {
    return { environmentId: null, healthy: false, error: 'no localhost environment registered', durationMs: Date.now() - startTime }
  }

  try {
    const res = await fetch(FALCO_HEALTHZ_URL, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) })
    if (!res.ok) {
      return { environmentId: hostEnv.id, healthy: false, error: `HTTP ${res.status}`, durationMs: Date.now() - startTime }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error(`[falco-health-poll] /healthz unreachable: ${error}`)
    return { environmentId: hostEnv.id, healthy: false, error, durationMs: Date.now() - startTime }
  }

  await prisma.environmentSourceHealth.upsert({
    where: {
      environmentId_source: { environmentId: hostEnv.id, source: FALCO_PROCESS_SOURCE },
    },
    update: { lastSeenAt: new Date() },
    create: {
      environmentId: hostEnv.id,
      source: FALCO_PROCESS_SOURCE,
      lastSeenAt: new Date(),
      lastWatermark: null,
      staleAfterMs: FALCO_STALE_AFTER_MS,
    },
  })

  return { environmentId: hostEnv.id, healthy: true, durationMs: Date.now() - startTime }
}
