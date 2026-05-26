/**
 * Observable extraction library — pure functions, no side effects.
 *
 * Extracts security-relevant observables (IPs, domains, hashes, URLs, MACs)
 * from incident event payloads. Used by the correlator worker (PR 4) and
 * the auto-extract API endpoint (PR 3).
 *
 * Design principles:
 *  - Refang on ingest, store canonical form in `value`, original in `displayValue`
 *  - Skip internal addresses (RFC1918, loopback, link-local) by default
 *  - Skip known false-positive hashes (empty file, etc.)
 *  - Per-source field mapping ensures we extract from the right payload fields
 *  - Auto-linking confidence rules prevent noise (IPs alone don't auto-link)
 */

// ── Types ────────────────────────────────────────────────────────────────────────

export type ObservableCategory =
  | 'ipv4'
  | 'ipv6'
  | 'domain'
  | 'url'
  | 'file_hash_md5'
  | 'file_hash_sha1'
  | 'file_hash_sha256'
  | 'mac_address'
  | 'email'
  | 'username'
  | 'file_path'
  | 'registry_key'
  | 'mutex'
  | 'asn'

export type ObservableVerdict = 'malicious' | 'suspicious' | 'benign' | 'unknown'

export interface ExtractedObservable {
  value: string
  displayValue: string
  category: ObservableCategory
  confidence: number
}

export interface ExtractionConfig {
  /** IPs to always include even if they'd normally be filtered */
  allowList?: string[]
  /** IPs/domains to always exclude */
  denyList?: string[]
  /** Domain suffixes to skip (e.g. ['local', 'lan', 'home.arpa']) */
  skipDomainSuffixes?: string[]
}

export interface LinkSuggestion {
  investigationId: string
  confidence: number
  matchedObservables: string[]
  /** 'auto' | 'suggestion' — whether to auto-link or just suggest */
  action: 'auto' | 'suggestion'
  reason: string
}

// ── Constants ────────────────────────────────────────────────────────────────────

/** MD5 of an empty file — extremely common false positive */
const EMPTY_FILE_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'
/** SHA1 of an empty file */
const EMPTY_FILE_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
/** SHA256 of an empty file */
const EMPTY_FILE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Refang substitutions */
const REFANG_REPLACEMENTS: [RegExp, string][] = [
  [/(?:hxxp|hxpx)/gi, 'http'],
  [/(?:fxxk|fxck)/gi, 'fuck'],
  [/\[\.]/g, '.'],
  [/\[::\]/gi, '::'],
  [/\[at\]/gi, '@'],
  [/\[colon\]/gi, ':'],
  [/\s+/g, ''],
]

/** RFC 1918 + loopback + link-local ranges */
const PRIVATE_RANGES_V4 = [
  { start: 0x00000000, end: 0x00000000 }, // 0.0.0.0/8
  { start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8 (loopback)
  { start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8
  { start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12
  { start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16
  { start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16 (link-local)
  { start: 0xfc000000, end: 0xfdffffff }, // 254.0.0.0/8
]

/** Regex patterns for extraction */
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g
const IPV6_RE = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi
const URL_RE = /\bhttps?:\/\/[^\s<>"'{}]+/gi
const MD5_RE = /\b([0-9a-f]{32})\b/gi
const SHA1_RE = /\b([0-9a-f]{40})\b/gi
const SHA256_RE = /\b([0-9a-f]{64})\b/gi
const MAC_RE = /\b([0-9a-f]{2}:[:0-9a-f]{2}:[:0-9a-f]{2}:[:0-9a-f]{2}:[:0-9a-f]{2}:[:0-9a-f]{2})\b/gi
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi
const FILE_PATH_RE = /\b(\/(?:[\w.-]+\/)*[\w.-]+)\b/g

// ── Source field mapping ─────────────────────────────────────────────────────────

/**
 * Field paths to scan per source type. Each path is a dot-separated key path
 * into the rawEvent payload. The extractor probes each path and extracts
 * observables from the string value found.
 */
const SOURCE_FIELD_MAP: Record<string, string[]> = {
  crowdsec: ['payload.value', 'source.ip', 'rawEvent.srcip', 'reason'],
  falco: ['fields.fd.sip', 'fields.fd.cip', 'output', 'proc.name', 'filename'],
  ntopng: ['cli_ip', 'srv_ip', 'info', 'dns_query'],
  elk: ['source.ip', 'destination.ip', 'dns.question.name', 'url.original', 'host.name'],
  unifi: ['src_ip', 'dst_ip', 'mac', 'hostname', 'identity'],
  suricata: ['src_ip', 'dest_ip', 'alert.signature', 'dns.rrname', 'http.hostname', 'http.uri'],
  wazuh: ['srcip', 'dstip', 'srcport', 'dstport', 'alert.description', 'hostname'],
}

// ── Refanging ────────────────────────────────────────────────────────────────────

/**
 * Convert defanged URLs/domains to canonical form.
 * hxxp://evil[.]com → http://evil.com
 */
export function refang(str: string): string {
  let result = str
  for (const [pattern, replacement] of REFANG_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

// ── IP validation ────────────────────────────────────────────────────────────────

/**
 * Check if an IPv4 address is in a private/reserved range.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return true
  const nums = parts.map(p => parseInt(p, 10))
  if (nums.some(n => isNaN(n) || n < 0 || n > 255)) return true
  const int = ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0
  for (const range of PRIVATE_RANGES_V4) {
    if (int >= range.start && int <= range.end) return true
  }
  return false
}

/**
 * Check if an IPv6 address is private (ULA, loopback, link-local).
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  return (
    lower.startsWith('fc') || // ULA
    lower.startsWith('fd') || // ULA
    lower.startsWith('fe80') || // Link-local
    lower === '::1' || // Loopback
    lower === '::' // Unspecified
  )
}

// ── Hash helpers ─────────────────────────────────────────────────────────────────

/** Known false-positive hashes (empty files) */
const FALSE_POSITIVE_HASHES = new Set([
  EMPTY_FILE_MD5,
  EMPTY_FILE_SHA1,
  EMPTY_FILE_SHA256,
])

/**
 * Check if a hash value is a known false positive.
 */
export function isFalsePositiveHash(value: string): boolean {
  return FALSE_POSITIVE_HASHES.has(value.toLowerCase())
}

/**
 * Detect hash type by length. Returns null if not a recognized hash.
 */
export function detectHashType(value: string): 'md5' | 'sha1' | 'sha256' | null {
  const cleaned = value.replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (cleaned.length === 32) return 'md5'
  if (cleaned.length === 40) return 'sha1'
  if (cleaned.length === 64) return 'sha256'
  return null
}

// ── Domain helpers ───────────────────────────────────────────────────────────────

/**
 * Check if a domain matches skip suffixes.
 */
export function shouldSkipDomain(
  domain: string,
  config: ExtractionConfig = {},
): boolean {
  const suffixes = config.skipDomainSuffixes ?? ['local', 'lan', 'home.arpa', 'localhost']
  const lower = domain.toLowerCase()
  return suffixes.some(s => lower.endsWith(`.${s}`) || lower === s)
}

// ── Extraction from text ────────────────────────────────────────────────────────

/**
 * Extract observables from a single text string.
 * This is the core extraction function — it scans raw text and returns
 * all identified observables with their categories and confidence scores.
 */
export function extractFromText(text: string, config: ExtractionConfig = {}): ExtractedObservable[] {
  const results = new Map<string, ExtractedObservable>()
  const allowSet = new Set(config.allowList?.map(s => s.toLowerCase()) ?? [])
  const denySet = new Set(config.denyList?.map(s => s.toLowerCase()) ?? [])

  function add(
    value: string,
    displayValue: string,
    category: ObservableCategory,
    confidence: number = 80,
  ): void {
    const key = `${category}:${value.toLowerCase()}`
    if (results.has(key)) return
    if (denySet.has(value.toLowerCase())) return
    results.set(key, { value, displayValue, category, confidence })
  }

  // Extract URLs first (they contain domains, so extract the domain from URLs separately)
  const urlMatches = text.match(URL_RE) ?? []
  for (const url of urlMatches) {
    const refanged = refang(url.trim().replace(/[)]$/, ''))
    const original = url.trim()
    add(refanged, original, 'url', 75)
    // Extract domain from URL
    try {
      const hostname = new URL(refanged).hostname
      if (hostname && !shouldSkipDomain(hostname, config)) {
        add(hostname, original, 'domain', 70)
      }
    } catch {
      // Malformed URL, skip domain extraction
    }
  }

  // Extract emails
  const emailMatches = text.match(EMAIL_RE) ?? []
  for (const email of emailMatches) {
    const ref = refang(email.toLowerCase())
    add(ref, email, 'email', 85)
  }

  // Extract IPv4
  const ipv4Matches = text.match(IPV4_RE) ?? []
  for (const ip of ipv4Matches) {
    const ref = refang(ip)
    if (allowSet.has(ref.toLowerCase()) || !isPrivateIPv4(ref)) {
      add(ref, ip, 'ipv4', 60)
    }
  }

  // Extract IPv6
  const ipv6Matches = text.match(IPV6_RE) ?? []
  for (const ip of ipv6Matches) {
    const ref = refang(ip)
    if (allowSet.has(ref.toLowerCase()) || !isPrivateIPv6(ref)) {
      add(ref, ip, 'ipv6', 60)
    }
  }

  // Extract domains (skip those already captured from URLs)
  const domainMatches = text.match(DOMAIN_RE) ?? []
  for (const domain of domainMatches) {
    const ref = refang(domain.toLowerCase())
    if (!shouldSkipDomain(ref, config)) {
      add(ref, domain, 'domain', 65)
    }
  }

  // Extract hashes (SHA256 first to avoid false SHA1/MD5 matches within)
  const sha256Matches = text.match(SHA256_RE) ?? []
  for (const hash of sha256Matches) {
    const lower = hash.toLowerCase()
    if (!isFalsePositiveHash(lower)) {
      add(lower, hash, 'file_hash_sha256', 95)
    }
  }

  const sha1Matches = text.match(SHA1_RE) ?? []
  for (const hash of sha1Matches) {
    const lower = hash.toLowerCase()
    if (!isFalsePositiveHash(lower)) {
      // Avoid matching SHA256 substrings
      if (!sha256Matches.some(s => s.toLowerCase().includes(lower))) {
        add(lower, hash, 'file_hash_sha1', 90)
      }
    }
  }

  const md5Matches = text.match(MD5_RE) ?? []
  for (const hash of md5Matches) {
    const lower = hash.toLowerCase()
    if (!isFalsePositiveHash(lower)) {
      // Avoid matching substrings of longer hashes
      if (
        !sha256Matches.some(s => s.toLowerCase().includes(lower)) &&
        !sha1Matches.some(s => s.toLowerCase().includes(lower))
      ) {
        add(lower, hash, 'file_hash_md5', 85)
      }
    }
  }

  // Extract MAC addresses
  const macMatches = text.match(MAC_RE) ?? []
  for (const mac of macMatches) {
    const ref = mac.toLowerCase()
    add(ref, mac, 'mac_address', 90)
  }

  return Array.from(results.values())
}

// ── Per-source extraction ────────────────────────────────────────────────────────

/**
 * Extract observables from a raw event payload, using source-specific
 * field mapping. This is the primary entry point for the correlator.
 */
export function extractFromEvent(
  source: string,
  rawEvent: Record<string, unknown>,
  config: ExtractionConfig = {},
): ExtractedObservable[] {
  const fields = SOURCE_FIELD_MAP[source] ?? extractDefaultFields(rawEvent)
  const texts = new Set<string>()

  for (const fieldPath of fields) {
    const value = resolvePath(rawEvent, fieldPath)
    if (typeof value === 'string' && value.trim().length > 0) {
      texts.add(value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim().length > 0) {
          texts.add(item)
        }
      }
    }
  }

  // Combine all extracted texts into a single string for extraction
  const combined = Array.from(texts).join(' ')
  return extractFromText(combined, config)
}

/**
 * Resolve a dot-separated path in an object. Returns the value or undefined.
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * When no source-specific mapping exists, fall back to scanning all string
 * values in the raw event payload (up to 3 levels deep to avoid huge objects).
 */
function extractDefaultFields(raw: Record<string, unknown>, depth = 0): string[] {
  if (depth > 3) return []
  const paths: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      paths.push(key)
    } else if (typeof value === 'object' && value !== null && depth < 3) {
      const sub = extractDefaultFields(value as Record<string, unknown>, depth + 1)
      for (const p of sub) {
        paths.push(`${key}.${p}`)
      }
    }
  }
  return paths
}

// ── Auto-linking confidence rules ────────────────────────────────────────────────

/**
 * Signal strength by observable category. Higher = stronger indicator
 * of a shared attacker across incidents.
 */
const SIGNAL_STRENGTH: Record<ObservableCategory, number> = {
  file_hash_md5: 95,
  file_hash_sha1: 95,
  file_hash_sha256: 95,
  mutex: 95,
  registry_key: 90,
  domain: 60,
  url: 55,
  email: 70,
  ipv4: 20,
  ipv6: 20,
  mac_address: 75,
  username: 40,
  file_path: 35,
  asn: 45,
}

/**
 * Determine auto-link confidence based on matching observables between
 * a new incident's extracted observables and an existing investigation's
 * observables.
 *
 * Rules:
 *  - Hash matches (md5, sha1, sha256), mutex, registry_key → auto-link immediately
 *  - 2+ observables match → medium confidence, auto-link
 *  - 1 domain/url match within 24h → suggestion only
 *  - IPv4/IPv6 alone → never auto-link, corroboration only
 */
export function computeLinkConfidence(
  newObservables: ExtractedObservable[],
  existingObservables: ExtractedObservable[],
  investigationOpenedAt: Date,
  now: Date = new Date(),
): LinkSuggestion | null {
  if (newObservables.length === 0 || existingObservables.length === 0) return null

  const existingSet = new Map(
    existingObservables.map(o => [`${o.category}:${o.value.toLowerCase()}`, o]),
  )

  const matches: { observable: string; category: ObservableCategory; strength: number }[] = []

  for (const obs of newObservables) {
    const key = `${obs.category}:${obs.value.toLowerCase()}`
    if (existingSet.has(key)) {
      const strength = SIGNAL_STRENGTH[obs.category] ?? 10
      matches.push({
        observable: obs.value,
        category: obs.category,
        strength,
      })
    }
  }

  if (matches.length === 0) return null

  // High-signal matches: hashes, mutex, registry keys → auto-link
  const highSignal = matches.filter(m => m.strength >= 90)
  if (highSignal.length > 0) {
    return {
      investigationId: '', // filled in by caller
      confidence: Math.max(...highSignal.map(m => m.strength)),
      matchedObservables: matches.map(m => `${m.category}:${m.observable}`),
      action: 'auto',
      reason: `High-signal observable match: ${highSignal.map(m => m.observable).join(', ')}`,
    }
  }

  // 2+ medium matches → auto-link
  const mediumSignal = matches.filter(m => m.strength >= 50)
  if (mediumSignal.length >= 2) {
    return {
      investigationId: '',
      confidence: Math.min(85, Math.max(...mediumSignal.map(m => m.strength)) + 10),
      matchedObservables: matches.map(m => `${m.category}:${m.observable}`),
      action: 'auto',
      reason: `Multiple medium-signal matches (${mediumSignal.length}): ${matches.map(m => m.observable).join(', ')}`,
    }
  }

  // Domain/URL within 24h → suggestion only
  const hoursSinceOpen = (now.getTime() - investigationOpenedAt.getTime()) / (1000 * 60 * 60)
  if (
    hoursSinceOpen <= 24 &&
    matches.some(m => m.category === 'domain' || m.category === 'url')
  ) {
    return {
      investigationId: '',
      confidence: Math.max(...matches.map(m => m.strength)),
      matchedObservables: matches.map(m => `${m.category}:${m.observable}`),
      action: 'suggestion',
      reason: `Domain/URL match within 24h window: ${matches.map(m => m.observable).join(', ')}`,
    }
  }

  // IP-only match → suggestion with low confidence
  const onlyIps = matches.every(m => m.category === 'ipv4' || m.category === 'ipv6')
  if (onlyIps) {
    return {
      investigationId: '',
      confidence: Math.max(...matches.map(m => m.strength)),
      matchedObservables: matches.map(m => `${m.category}:${m.observable}`),
      action: 'suggestion',
      reason: `IP-only match (corroboration): ${matches.map(m => m.observable).join(', ')}`,
    }
  }

  // Fallback: single medium match outside 24h → suggestion
  return {
    investigationId: '',
    confidence: Math.max(...matches.map(m => m.strength)),
    matchedObservables: matches.map(m => `${m.category}:${m.observable}`),
    action: 'suggestion',
    reason: `Observable match: ${matches.map(m => m.observable).join(', ')}`,
  }
}

// ── Batch extraction ─────────────────────────────────────────────────────────────

/**
 * Extract observables from multiple events (e.g. all events in an incident).
 * Deduplicates by (category, value) and takes the highest confidence.
 */
export function extractFromEvents(
  events: { source: string; rawEvent: Record<string, unknown> }[],
  config: ExtractionConfig = {},
): ExtractedObservable[] {
  const seen = new Map<string, ExtractedObservable>()

  for (const event of events) {
    const observables = extractFromEvent(event.source, event.rawEvent, config)
    for (const obs of observables) {
      const key = `${obs.category}:${obs.value.toLowerCase()}`
      const existing = seen.get(key)
      if (!existing || obs.confidence > existing.confidence) {
        seen.set(key, obs)
      }
    }
  }

  return Array.from(seen.values())
}
