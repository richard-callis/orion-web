/**
 * Text handling for self-diagnosis: redaction of untrusted log/error text,
 * normalization into a stable message, and fingerprinting.
 */
import { createHash } from 'node:crypto'
import { redactSecrets } from '@/lib/redact'

export const EXCERPT_MAX = 2000

/** One observed fault. `message` is already redacted; `fingerprint` is derived from kind + normalized message. */
export interface Signal {
  kind: string
  area: string
  message: string
  fingerprint: string
  /** Stable id of what was seen (row id), so re-reading the same row is a no-op. */
  ref: string
  at: Date
  /** True when the signal comes from a time-windowed query (advances the watermark); false for state checks. */
  windowed: boolean
  /** Fault in a security data source: filed as high severity. */
  high: boolean
  excerpt: string
}

const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi // scheme://user:pass@host
const SECRET_ASSIGNMENT = /\b(\w*(?:key|token|secret|passw(?:or)?d|pwd)\w*\s*=\s*)["']?[^\s"',;}]+/gi
const KNOWN_TOKENS = /\bBearer\s+[\w.~+/-]+=*|\beyJ[\w-]*\.eyJ[\w-]*\.[\w-]+|\b(?:orion_ak|mcg)_[\w-]+/gi // bearer, JWT, ORION keys
const LONG_BLOB = /(?<![\w/.+=-])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9][A-Za-z0-9+/_-]{39,}={0,2}(?![\w/.-])/g // base64/hex

/**
 * Strip anything secret-looking from untrusted text. (redactSensitive is not
 * used: its callback never masks patterns without capture groups.)
 */
export function redact(text: string): string {
  return redactSecrets(text.replace(CREDENTIAL_URL, '$1[REDACTED]@').replace(KNOWN_TOKENS, '[REDACTED]'))
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(LONG_BLOB, '[REDACTED]')
}

const NORMALIZATIONS: Array<[RegExp, string]> = [
  [/(?<!\w)"[^"\n]*"(?!\w)|(?<!\w)'[^'\n]*'(?!\w)|`[^`\n]*`/g, '<q>'],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>'],
  [/\bc(?=[a-z0-9]*\d)[a-z0-9]{24}\b/g, '<id>'], // cuid
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>'],
  [/\d+(?:\.\d+)?/g, '<n>'],
]

/** Replace ids, UUIDs, hex, numbers, timestamps, IPs and quoted values so repeats of one fault compare equal. */
export function normalizeMessage(message: string): string {
  let out = message
  for (const [re, to] of NORMALIZATIONS) out = out.replace(re, to)
  return out.replace(/\s+/g, ' ').trim()
}

export function fingerprintOf(kind: string, normalized: string): string {
  return createHash('sha256').update(`${kind}\n${normalized}`).digest('hex')
}

export function makeSignal(p: {
  kind: string; area: string; text: string; ref: string; at: Date
  windowed: boolean; high?: boolean; excerpt?: string
}): Signal {
  const message = redact(p.text).slice(0, 500)
  return {
    kind: p.kind, area: p.area, message, ref: p.ref, at: p.at, windowed: p.windowed, high: p.high ?? false,
    fingerprint: fingerprintOf(p.kind, normalizeMessage(message)),
    excerpt: redact(p.excerpt ?? p.text).slice(0, EXCERPT_MAX),
  }
}
