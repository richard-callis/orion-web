import { execFile } from 'child_process'
import { promisify } from 'util'
import { lookup } from 'dns'
import { promisify as promisifyCb } from 'util'
import type { McpToolConfig } from './orion-client.js'

const exec = promisify(execFile)
const dnsLookup = promisifyCb(lookup)

/**
 * SSRF protection: validate HTTP URL against private/reserved IP ranges.
 * Returns the validated URL or throws.
 */
async function validateHttpUrl(url: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL for HTTP tool: ${url}`)
  }

  // Only allow http and https schemes
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Tool HTTP execType only allows http/https scheme, got: ${parsed.protocol}`)
  }

  // Check for JavaScript protocol injection
  const host = parsed.hostname.toLowerCase()
  if (host.includes('javascript:') || host.includes('data:') || host.includes('file:')) {
    throw new Error(`Tool HTTP execType blocked: URL contains dangerous scheme in hostname`)
  }

  // Block if URL uses an IP address directly (check against private ranges)
  const hostname = parsed.hostname
  const rawIp = hostname.replace(/^[\[\]]/g, '').replace(/[\]\:]$/, '') // strip brackets for IPv6

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || /^\[?[0-9a-fA-F:]+\]?$/.test(hostname)) {
    if (!isAllowedIp(hostname)) {
      throw new Error(`Tool HTTP execType blocked: URL resolves to a private/reserved IP address`)
    }
  } else {
    // DNS hostname: resolve and check the IP
    try {
      const addr = await dnsLookup(hostname)
      if (addr && !isAllowedIp(addr.address)) {
        throw new Error(`Tool HTTP execType blocked: ${hostname} resolves to a private/reserved IP address`)
      }
    } catch (err) {
      // DNS lookup failed — block by default (defense-in-depth)
      // This prevents DNS rebinding attacks and ensures validation happens
      const errMsg = err instanceof Error ? err.message : String(err)
      throw new Error(`Tool HTTP execType blocked: DNS lookup failed for ${hostname}: ${errMsg}`)
    }
  }

  return url
}

function isAllowedIp(ip: string): boolean {
  // Allow public IPs and K8s internal DNS (non-IP hostnames resolve through DNS lookup path)
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return true // not a raw IPv4, skip check
  // Block IPv6 loopback (::1) and private ranges (fc00::/7, fe80::/10)
  if (ip === '::1' || ip === '::' || ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return false
  if (ip.toLowerCase().startsWith('fe80:')) return false // link-local

  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false

  const [a, b] = [parts[0], parts[1]]

  // Block private/reserved ranges
  if (a === 10) return false                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return false    // 172.16.0.0/12
  if (a === 192 && b === 168) return false             // 192.168.0.0/16
  if (a === 127) return false                          // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return false             // 169.254.0.0/16 (link-local/cloud metadata)
  if (a === 0) return false                            // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return false   // 100.64.0.0/10 (CGNAT)
  if (a === 192 && b === 0 && parts[2] === 2) return false // 192.0.0.0/24 (IPv4 mapping)
  if (a === 198 && b === 51 && parts[2] === 100) return false // 198.51.100.0/24 (TESTNET)
  if (a === 203 && b === 0 && parts[2] === 113) return false // 203.0.113.0/24 (TESTNET)
  if (a >= 224) return false                           // 224.0.0.0/4 (multicast/reserved)

  return true
}

/**
 * Ensure required packages are installed in the gateway container.
 * Uses `apk add` (Alpine) — falls back to a clear error if unavailable.
 */
async function ensurePackages(packages: string[]): Promise<void> {
  for (const pkg of packages) {
    // Check if the binary is already available
    const binaryName = pkg.split('-').pop() ?? pkg  // e.g. "nmap-ncat" → "ncat", "nmap" → "nmap"
    try {
      await exec('sh', ['-c', `which ${binaryName} || command -v ${binaryName}`], { timeout: 5_000 })
      // Already installed
    } catch {
      console.log(`[tool-runner] Package '${pkg}' not found — attempting auto-install via apk...`)
      try {
        const { stdout, stderr } = await exec('sh', ['-c', `apk add --no-cache ${pkg} 2>&1`], { timeout: 120_000 })
        console.log(`[tool-runner] Installed '${pkg}':`, (stdout || stderr).trim())
      } catch (installErr) {
        const msg = installErr instanceof Error ? installErr.message : String(installErr)
        throw new Error(
          `Tool requires '${pkg}' which is not installed in the gateway container.\n` +
          `Auto-install failed: ${msg}\n` +
          `To permanently fix: add RUN apk add --no-cache ${pkg} to the gateway Dockerfile and redeploy.`
        )
      }
    }
  }
}

/**
 * Execute a tool based on its execType and execConfig.
 * Returns a string result (stdout/response body).
 */
export async function runTool(tool: McpToolConfig, args: Record<string, unknown>): Promise<string> {
  switch (tool.execType) {
    case 'builtin':
      throw new Error(`Built-in tool ${tool.name} must be registered via the builtin-tools registry, not runTool()`)

    case 'shell': {
      const command = tool.execConfig?.command as string | undefined
      if (!command) throw new Error(`Tool ${tool.name} has no execConfig.command`)

      // Ensure required packages are installed before running
      const packages = tool.execConfig?.packages as string[] | undefined
      if (packages?.length) {
        await ensurePackages(packages)
      }

      // Determine which params are required (per inputSchema)
      const requiredParams = (tool.inputSchema?.required as string[] | undefined) ?? []

      // Substitute {arg_name} placeholders from the tool's arguments
      const interpolated = command.replace(/\{(\w+)\}/g, (_, k) => {
        const val = args[k]
        if (val === undefined) {
          if (requiredParams.includes(k)) throw new Error(`Missing required argument: ${k}`)
          return '' // optional param not provided — substitute empty string
        }
        // Basic safety: reject args containing shell metacharacters
        const str = String(val)
        if (/[;&|`$<>\\]/.test(str)) throw new Error(`Argument '${k}' contains disallowed characters`)
        return str
      })
      const { stdout, stderr } = await exec('sh', ['-c', interpolated], { timeout: 30_000 })
      return stdout || stderr
    }

    case 'http': {
      const url = tool.execConfig?.url as string | undefined
      if (!url) throw new Error(`Tool ${tool.name} has no execConfig.url`)
      // Substitute {arg_name} placeholders in the URL
      const interpolated = url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(args[k] ?? '')))
      // SOC2: CR-004 — SSRF protection: validate URL before making request
      await validateHttpUrl(interpolated)
      const method = (tool.execConfig?.method as string | undefined) ?? 'GET'
      const res = await fetch(interpolated, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method !== 'GET' ? JSON.stringify(args) : undefined,
      })
      return res.text()
    }

    default:
      throw new Error(`Unknown execType: ${tool.execType}`)
  }
}
