/**
 * K8s events normalizer (Phase 2 PR8).
 *
 * Converts items from a `kubectl get events --field-selector type=Warning -o json`
 * response into NormalizedSecurityEvent. Called by security-poll-k8s.ts.
 *
 * Dedup keys on `event.metadata.uid + event.count` — NOT lastTimestamp,
 * because K8s bumps count + lastTimestamp on repeat events. The combo
 * (uid, count) is monotonic and corresponds 1:1 to a unique aggregated
 * event occurrence.
 *
 * Severity table per phase2-managed-infra-telemetry.md.
 */
import crypto from 'crypto'
import { type NormalizedSecurityEvent } from '../types'

export interface K8sEvent {
  metadata: {
    uid: string
    name: string
    namespace?: string
    resourceVersion: string
  }
  reason: string
  message?: string
  type: string
  count?: number
  firstTimestamp?: string
  lastTimestamp?: string
  eventTime?: string
  involvedObject?: {
    kind?: string
    name?: string
    namespace?: string
    fieldPath?: string
  }
}

// ── Reason → severity ─────────────────────────────────────────────────────────

const REASON_SEVERITY: Array<{
  pattern: RegExp
  severity: number
  eventType: string
}> = [
  { pattern: /^CrashLoopBackOff$/, severity: 60, eventType: 'k8s.crash_loop_backoff' },
  { pattern: /^OOMKilled$/, severity: 65, eventType: 'k8s.oom_killed' },
  { pattern: /^ImagePullBackOff$/, severity: 30, eventType: 'k8s.image_pull_backoff' },
  { pattern: /^ErrImagePull$/, severity: 30, eventType: 'k8s.err_image_pull' },
  { pattern: /^Evicted$/, severity: 50, eventType: 'k8s.evicted' },
  { pattern: /^Failed$/, severity: 40, eventType: 'k8s.failed' }, // health check
  { pattern: /^Unhealthy$/, severity: 40, eventType: 'k8s.unhealthy' },
  { pattern: /PolicyViolation/i, severity: 75, eventType: 'k8s.policy_violation' },
  { pattern: /^FailedMount$/, severity: 55, eventType: 'k8s.failed_mount' },
  { pattern: /^FailedAttachVolume$/, severity: 55, eventType: 'k8s.failed_attach_volume' },
  { pattern: /^BackOff$/, severity: 50, eventType: 'k8s.back_off' },
  { pattern: /^FailedScheduling$/, severity: 40, eventType: 'k8s.failed_scheduling' },
  { pattern: /AdmissionWebhook|Admission/i, severity: 65, eventType: 'k8s.admission_webhook_failure' },
  { pattern: /^FailedCreatePodSandBox$/, severity: 60, eventType: 'k8s.sandbox_failed' },
]

function eventTypeFor(reason: string): { severity: number; type: string } {
  const match = REASON_SEVERITY.find((r) => r.pattern.test(reason))
  if (match) return { severity: match.severity, type: match.eventType }
  return { severity: 25, type: `k8s.${slugify(reason)}` }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

// ── Modifier: namespace bump for kube-system / control-plane noise ───────────

function namespaceModifier(namespace: string | undefined): number {
  if (!namespace) return 0
  if (
    namespace === 'kube-system' ||
    namespace === 'kube-public' ||
    namespace.startsWith('argocd') ||
    namespace.startsWith('vault')
  ) {
    return 15
  }
  return 0
}

// ── BackOff on privileged pod escalation ─────────────────────────────────────
// Encoded as a hint in the message — the message will say something like
// "Back-off restarting failed container" with no privileged signal; we leave
// the bump for correlation rules in PR9 rather than try to detect "privileged"
// from event text here.

// ── Normalizer ───────────────────────────────────────────────────────────────

export function normalizeK8sEvent(
  event: K8sEvent,
  environmentId: string
): NormalizedSecurityEvent {
  const { severity: baseSeverity, type } = eventTypeFor(event.reason)
  const namespace = event.metadata.namespace ?? event.involvedObject?.namespace
  const severity = clamp(baseSeverity + namespaceModifier(namespace), 0, 100)

  const count = event.count ?? 1
  const dedupKey = sha256(`${environmentId}|${event.metadata.uid}|${count}`)

  const lastTimestamp =
    event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? new Date().toISOString()
  const timestamp = new Date(lastTimestamp)

  const involved =
    event.involvedObject?.kind && event.involvedObject?.name
      ? `${event.involvedObject.kind}/${event.involvedObject.name}`
      : event.metadata.name
  const title = `K8s ${event.reason}: ${involved}${namespace ? ` (${namespace})` : ''}`

  return {
    environmentId,
    type,
    source: 'k8s_events',
    severity,
    title,
    description: event.message ?? null,
    rawEvent: event as unknown as Record<string, unknown>,
    dedupKey,
    sourceName: involved,
    timestamp,
    metadata: {
      environmentId,
      reason: event.reason,
      namespace,
      involvedObject: event.involvedObject ?? null,
      count,
      resourceVersion: event.metadata.resourceVersion,
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}
