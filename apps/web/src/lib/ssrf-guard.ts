import { promises as dns } from 'dns'

const PRIVATE_IP_PATTERNS = [
  /^127\./,                          // loopback
  /^10\./,                           // RFC1918
  /^192\.168\./,                     // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC1918
  /^169\.254\./,                     // link-local
  /^100\.(6[4-9]|[7-9]\d|1([01]\d|2[0-7]))\./,  // CGNAT 100.64.0.0/10
  /^::1$/,                           // IPv6 loopback
  /^::ffff:/i,                       // IPv4-mapped
  /^::ffff:0:/i,                     // IPv4-mapped alternate form
  /^f[cd][0-9a-f]{2}:/i,            // ULA fc00::/7
  /^fe80:/i,                         // IPv6 link-local
  /^0\.0\.0\.0$/,
  /^0\b/,                            // 0.x.x.x
]

export function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some(p => p.test(ip))
}

/**
 * Returns true if the URL should be blocked: non-http/https scheme,
 * hostname resolves to a private/internal IP, or DNS lookup fails.
 *
 * Set ALLOW_PRIVATE_GATEWAY_URLS=true to permit RFC1918 addresses —
 * useful for self-hosted / homelab deployments where the gateway runs
 * on the same private network as ORION.
 *
 * Note: DNS is resolved twice in current implementation (here and at fetch time).
 * Callers should set redirect:'manual' and re-validate on redirects.
 */
export async function isPrivateUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
    const { hostname } = parsed
    if (hostname === 'localhost' || hostname === '0.0.0.0') return true
    // Reject numeric IP encodings (decimal, hex, octal) that bypass hostname check
    if (/^\d+$/.test(hostname)) return true          // pure decimal
    if (/^0x[0-9a-f]+$/i.test(hostname)) return true // hex
    const allowPrivate = process.env.ALLOW_PRIVATE_GATEWAY_URLS === 'true'
    // If hostname is a direct IP address, no DNS needed
    if (isPrivateIp(hostname)) return !allowPrivate
    if (/^[\d.]+$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname)) return false // non-private IP
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ])
    if (v4.length === 0 && v6.length === 0) return true // DNS failed — block
    return allowPrivate ? false : [...v4, ...v6].some(isPrivateIp)
  } catch { return true }
}
