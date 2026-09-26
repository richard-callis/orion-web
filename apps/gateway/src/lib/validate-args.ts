/**
 * Shared validators for agent-supplied CLI arguments.
 *
 * Built-in tools pass agent input to kubectl / helm / docker / velero /
 * talosctl as argv elements. execFile prevents *shell* injection, but not
 * *flag* injection: a "name" of `--server=https://attacker` or
 * `--kubeconfig=/x` becomes a CLI flag and changes what the command does
 * (e.g. kubectl would send the pod's service-account token to the attacker).
 *
 * Every validator throws ArgValidationError with a message safe to return to
 * the agent, and returns the normalised string.
 */

import { isIP } from 'net'

export class ArgValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgValidationError'
  }
}

function fail(field: string, why: string): never {
  throw new ArgValidationError(`Invalid argument '${field}': ${why}`)
}

/** String with no leading '-', no control characters, non-empty, bounded length. */
export function noFlag(field: string, value: unknown, maxLen = 1024): string {
  if (value === undefined || value === null) fail(field, 'is required')
  const s = String(value)
  if (s.length === 0) fail(field, 'must not be empty')
  if (s.length > maxLen) fail(field, `must be at most ${maxLen} characters`)
  if (s.startsWith('-')) fail(field, 'must not start with "-"')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) fail(field, 'must not contain control characters')
  return s
}

const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/** Kubernetes object name (DNS-1123 subdomain, ≤253). */
export function k8sName(field: string, value: unknown): string {
  const s = noFlag(field, value, 253)
  if (!DNS1123_SUBDOMAIN.test(s)) fail(field, 'must be a valid Kubernetes name (lowercase alphanumerics, "-" and ".")')
  return s
}

/** Kubernetes namespace / container name (DNS-1123 label, ≤63). */
export function k8sLabel(field: string, value: unknown): string {
  const s = noFlag(field, value, 63)
  if (!DNS1123_LABEL.test(s)) fail(field, 'must be a valid DNS-1123 label (lowercase alphanumerics and "-")')
  return s
}

export const k8sNamespace = k8sLabel

/** Resource type such as `pod`, `deployments.apps`, `nodes.longhorn.io`. */
export function k8sResource(field: string, value: unknown): string {
  const s = noFlag(field, value, 253)
  if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(s)) fail(field, 'must be a resource type like "pod" or "deployments.apps"')
  return s
}

/** Label selector, e.g. `app=nginx,tier!=db` or `env in (a,b)`. */
export function labelSelector(field: string, value: unknown): string {
  const s = noFlag(field, value, 1024)
  if (!/^[A-Za-z0-9_./=!,()\s-]+$/.test(s)) fail(field, 'contains characters not allowed in a label selector')
  return s
}

export function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  const s = String(value ?? '')
  if (!(allowed as readonly string[]).includes(s)) fail(field, `must be one of: ${allowed.join(', ')}`)
  return s as T
}

/** Durations like `120s`, `5m`, `720h0m0s`, `1h30m`, or a bare integer. */
export function duration(field: string, value: unknown): string {
  const s = noFlag(field, value, 32)
  if (!/^(\d+|(\d+(ms|s|m|h|d))+)$/.test(s)) fail(field, 'must be a duration like "120s", "5m" or "720h0m0s"')
  return s
}

/** Parse a validated duration into seconds (used to size exec timeouts). */
export function durationSeconds(d: string): number {
  if (/^\d+$/.test(d)) return parseInt(d, 10)
  let total = 0
  for (const m of d.matchAll(/(\d+)(ms|s|m|h|d)/g)) {
    const n = parseInt(m[1], 10)
    total += m[2] === 'ms' ? n / 1000 : m[2] === 's' ? n : m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86400
  }
  return Math.ceil(total)
}

export function positiveInt(field: string, value: unknown, max = 100_000): number {
  const n = typeof value === 'number' ? value : Number(String(value))
  if (!Number.isInteger(n) || n < 0 || n > max) fail(field, `must be an integer between 0 and ${max}`)
  return n
}

/** Docker container name or ID. */
export function dockerName(field: string, value: unknown): string {
  const s = noFlag(field, value, 255)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s)) fail(field, 'must be a valid container name or ID')
  return s
}

/** Container image reference, e.g. `ghcr.io/org/img:tag` or `img@sha256:…`. */
export function imageRef(field: string, value: unknown): string {
  const s = noFlag(field, value, 512)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/.test(s)) fail(field, 'must be a valid image reference')
  return s
}

/** Helm release / repo name. */
export function helmName(field: string, value: unknown): string {
  const s = noFlag(field, value, 53)
  if (!/^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/i.test(s)) fail(field, 'must be alphanumerics with "-", "_" or "."')
  return s
}

/** IP address or DNS hostname (e.g. a Talos node endpoint). */
export function hostOrIp(field: string, value: unknown): string {
  const s = noFlag(field, value, 253)
  if (isIP(s)) return s
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(s)) {
    fail(field, 'must be an IP address or hostname')
  }
  return s
}

/** http(s) URL (no SSRF policy — see ssrf.ts for that). */
export function httpUrl(field: string, value: unknown, schemes: readonly string[] = ['http:', 'https:']): string {
  const s = noFlag(field, value, 2048)
  let u: URL
  try { u = new URL(s) } catch { fail(field, 'must be a valid URL') }
  if (!schemes.includes(u.protocol)) fail(field, `URL scheme must be one of: ${schemes.join(', ')}`)
  return s
}

/** Run a tool body, converting validation failures into an agent-readable error string. */
export async function withValidation(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ArgValidationError) return `Error: ${err.message}`
    throw err
  }
}
