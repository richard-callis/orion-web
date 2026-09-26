/**
 * SSRF-safe outbound HTTP for agent-influenced URLs.
 *
 * The earlier guard (resolve-then-fetch) was bypassable:
 *   - IPv4-mapped IPv6 literals (`[::ffff:7f00:1]`, `[::ffff:169.254.169.254]`) passed
 *   - DNS was resolved once for the check and again by fetch (rebinding / TOCTOU)
 *   - fetch followed redirects, so a public URL could 302 to 169.254.169.254
 *   - only the first A record was checked; no timeout; unbounded body
 *
 * safeFetch() fixes all of these:
 *   - literal IPs are checked directly (net skips lookup for literals)
 *   - hostnames resolve through a custom `lookup` passed to http.request, which
 *     checks EVERY resolved address and hands the socket the address it checked,
 *     so there is no second resolution for an attacker to race
 *   - redirects are followed manually (max 5) and every hop is re-validated
 *   - hard timeout and byte cap on the response body
 */

import http from 'http'
import https from 'https'
import { lookup as dnsLookup } from 'dns'
import { isIP, isIPv4, isIPv6, type LookupFunction } from 'net'

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

// ── IP policy ────────────────────────────────────────────────────────────────

function ipv4Allowed(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = p
  if (a === 0) return false                              // 0.0.0.0/8
  if (a === 10) return false                             // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return false     // 100.64.0.0/10 CGNAT
  if (a === 127) return false                            // loopback
  if (a === 169 && b === 254) return false               // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false      // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return false      // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return false      // TEST-NET-1
  if (a === 192 && b === 168) return false               // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return false  // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false   // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false    // TEST-NET-3
  if (a >= 224) return false                             // multicast + reserved + broadcast
  return true
}

/** Expand an IPv6 address (optionally with embedded dotted IPv4) into 8 hextets. */
function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  // Rewrite a trailing dotted IPv4 (e.g. ::ffff:1.2.3.4) as two hex groups.
  const lastColon = s.lastIndexOf(':')
  const maybeV4 = s.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    if (!isIPv4(maybeV4)) return null
    const q = maybeV4.split('.').map(Number)
    s = `${s.slice(0, lastColon + 1)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`
  }
  const want = 8
  const parts = s.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':').filter(x => x !== '') : []
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':').filter(x => x !== '') : []
  let groups: string[]
  if (parts.length === 2) {
    const fill = want - head.length - rest.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== want) return null
  const nums = groups.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  if (nums.some(n => Number.isNaN(n))) return null
  return nums
}

function embeddedV4(h: number[], hiIdx: number): string {
  return `${h[hiIdx] >> 8}.${h[hiIdx] & 0xff}.${h[hiIdx + 1] >> 8}.${h[hiIdx + 1] & 0xff}`
}

function ipv6Allowed(ip: string): boolean {
  const h = expandIPv6(ip)
  if (!h) return false
  const zeroPrefix = (n: number) => h.slice(0, n).every(x => x === 0)
  if (h.every(x => x === 0)) return false                            // ::
  if (zeroPrefix(7) && h[7] === 1) return false                      // ::1
  if (zeroPrefix(5) && h[5] === 0xffff) return ipv4Allowed(embeddedV4(h, 6)) // ::ffff:a.b.c.d (mapped)
  if (zeroPrefix(6)) return false                                    // ::a.b.c.d (deprecated compat)
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return ipv4Allowed(embeddedV4(h, 6))                             // 64:ff9b::/96 NAT64
  }
  if (h[0] === 0x2002) return ipv4Allowed(embeddedV4(h, 1))          // 6to4
  if ((h[0] & 0xfe00) === 0xfc00) return false                       // fc00::/7 ULA
  if ((h[0] & 0xffc0) === 0xfe80) return false                       // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return false                       // fec0::/10 site-local
  if ((h[0] & 0xff00) === 0xff00) return false                       // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false               // documentation
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return false // discard-only
  return true
}

/** True if the address is a public unicast address that outbound tool traffic may reach. */
export function isAllowedIp(ip: string): boolean {
  const s = ip.replace(/^\[|\]$/g, '')
  if (isIPv4(s)) return ipv4Allowed(s)
  if (isIPv6(s)) return ipv6Allowed(s)
  return false
}

// ── URL validation ───────────────────────────────────────────────────────────

export function assertSafeUrlShape(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new SsrfBlockedError(`invalid URL: ${raw}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfBlockedError(`only http/https URLs are allowed (got ${u.protocol})`)
  }
  if (u.username || u.password) throw new SsrfBlockedError('URLs with embedded credentials are not allowed')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new SsrfBlockedError('URL has no host')
  // WHATWG URL already normalises decimal/octal/hex IPv4 forms (e.g. 2130706433 → 127.0.0.1).
  if (isIP(host) && !isAllowedIp(host)) {
    throw new SsrfBlockedError(`URL points to a private/reserved address (${host})`)
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfBlockedError('URL points to localhost')
  }
  return u
}

/** DNS lookup that rejects if ANY resolved address is private/reserved. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: (options as { family?: number }).family ?? 0 }, (err, addresses) => {
    const cb = callback as (...args: unknown[]) => void
    if (err) return cb(err)
    const list = addresses as Array<{ address: string; family: number }>
    if (list.length === 0) return cb(new SsrfBlockedError(`${hostname} did not resolve`))
    for (const a of list) {
      if (!isAllowedIp(a.address)) {
        return cb(new SsrfBlockedError(`${hostname} resolves to a private/reserved address (${a.address})`))
      }
    }
    if ((options as { all?: boolean }).all) return cb(null, list)
    return cb(null, list[0].address, list[0].family)
  })
}

// ── safeFetch ────────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** 'truncate' returns the first maxBytes with a marker; 'error' rejects. */
  onOverflow?: 'truncate' | 'error'
  /** Test hook only — replaces the guarded DNS lookup. Never set in production code. */
  lookup?: LookupFunction
}

export interface SafeFetchResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
  truncated: boolean
  finalUrl: string
}

function requestOnce(
  u: URL,
  opts: Required<Pick<SafeFetchOptions, 'method' | 'maxBytes' | 'onOverflow'>> & SafeFetchOptions,
  signal: AbortSignal,
): Promise<SafeFetchResult> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      u,
      { method: opts.method, headers: opts.headers, lookup: opts.lookup ?? guardedLookup, signal },
      res => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        res.on('data', (chunk: Buffer) => {
          if (truncated) return
          size += chunk.length
          if (size > opts.maxBytes) {
            if (opts.onOverflow === 'error') {
              res.destroy()
              reject(new Error(`response body exceeds ${opts.maxBytes} bytes`))
              return
            }
            chunks.push(chunk.subarray(0, chunk.length - (size - opts.maxBytes)))
            truncated = true
            res.destroy()
            finish()
            return
          }
          chunks.push(chunk)
        })
        let done = false
        const finish = () => {
          if (done) return
          done = true
          let body = Buffer.concat(chunks).toString('utf8')
          if (truncated) body += `\n[truncated — response exceeded ${opts.maxBytes} bytes]`
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, truncated, finalUrl: u.toString() })
        }
        res.on('end', finish)
        res.on('error', err => { if (!done) reject(err) })
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const opts = {
    method: 'GET',
    timeoutMs: 30_000,
    maxBytes: 1024 * 1024,
    maxRedirects: 5,
    onOverflow: 'truncate' as const,
    ...options,
  }
  const signal = AbortSignal.timeout(opts.timeoutMs)
  let url = assertSafeUrlShape(rawUrl)
  let method = opts.method.toUpperCase()
  let body = opts.body

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const res = await requestOnce(url, { ...opts, method, body }, signal)
    const loc = res.headers.location
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hop === opts.maxRedirects) throw new SsrfBlockedError(`too many redirects (>${opts.maxRedirects})`)
      url = assertSafeUrlShape(new URL(loc, url).toString())
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET'
        body = undefined
      }
      continue
    }
    return res
  }
  throw new SsrfBlockedError('too many redirects')
}
