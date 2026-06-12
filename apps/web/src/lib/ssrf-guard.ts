import { promises as dns } from 'dns'

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/, /^::ffff:/i,
  /^f[cd][0-9a-f]{2}:/i, // fc00::/7 ULA (covers fc00:: and fd00::)
  /^fe80:/i,
  /^0\.0\.0\.0$/,
]

export function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some(p => p.test(ip))
}

/**
 * Returns true if the URL should be blocked: non-http/https scheme,
 * hostname resolves to a private/internal IP, or DNS lookup fails.
 */
export async function isPrivateUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
    const { hostname } = parsed
    if (hostname === 'localhost' || hostname === '0.0.0.0') return true
    if (isPrivateIp(hostname)) return true
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ])
    return [...v4, ...v6].some(isPrivateIp)
  } catch { return true }
}
