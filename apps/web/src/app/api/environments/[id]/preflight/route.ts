export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/:id/preflight
 *
 * Streams Server-Sent Events showing live progress as ORION checks the cluster.
 *
 * Event types:
 *   { type: 'log',   message: string }                          — informational line
 *   { type: 'check', check: PreflightCheck }                    — one check completed
 *   { type: 'done',  canBootstrap, credentialNeeded?, clusterFlavor?, gitOwner, gitRepo }
 *   { type: 'error', message: string }                          — fatal failure
 */
import { NextRequest } from 'next/server'
import { spawn } from 'child_process'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { createConnection } from 'net'
import { prisma } from '@/lib/db'
import { getGitProvider } from '@/lib/git-provider'

// ── Types ──────────────────────────────────────────────────────────────────────

type CheckStatus      = 'ok' | 'missing' | 'error' | 'skipped'
type ClusterFlavor    = 'talos' | 'k3s' | 'unknown' | 'unreachable'
type CredentialNeeded = 'nodeIp' | 'talosconfig' | 'kubeconfig'

interface PreflightCheck {
  id:     string
  label:  string
  status: CheckStatus
  detail: string
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function runQuiet(cmd: string, args: string[], env: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr.on('data', (d: Buffer) => chunks.push(d))
    proc.on('close', (code) => resolve({ ok: code === 0, out: Buffer.concat(chunks).toString().trim() }))
    proc.on('error', (e) => resolve({ ok: false, out: e.message }))
  })
}

function probeTcpPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('error',   () => resolve(false))
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
  })
}

async function detectClusterFlavor(nodeIp: string): Promise<ClusterFlavor> {
  const [talosMgmt, k8sApi] = await Promise.all([
    probeTcpPort(nodeIp, 50000),
    probeTcpPort(nodeIp, 6443),
  ])
  if (talosMgmt) return 'talos'
  if (k8sApi)    return 'k3s'
  return 'unreachable'
}

async function fetchTalosKubeconfig(nodeIp: string, talosconfigB64: string, tmpDir: string): Promise<string> {
  const talosconfigPath = join(tmpDir, 'talosconfig')
  const kubeconfigPath  = join(tmpDir, 'fetched-kubeconfig')
  await writeFile(talosconfigPath, Buffer.from(talosconfigB64, 'base64').toString('utf8'), { mode: 0o600 })
  const result = await runQuiet('talosctl', [
    'kubeconfig', '--nodes', nodeIp, '--endpoints', nodeIp,
    '--talosconfig', talosconfigPath, '--force', kubeconfigPath,
  ], {})
  if (!result.ok) throw new Error(`talosctl kubeconfig failed: ${result.out}`)
  const { readFile } = await import('fs/promises')
  let kubeconfigYaml = await readFile(kubeconfigPath, 'utf8')

  // talosctl kubeconfig sets server: https://<node-ip>:6443, but the actual
  // kube-apiserver may be on a different IP (VIP / dedicated endpoint).
  // Query Talos to find the real kube-apiserver address and fix the kubeconfig.
  const epResult = await runQuiet('talosctl', [
    '--nodes', nodeIp, '--endpoints', nodeIp,
    '--talosconfig', talosconfigPath,
    'get', 'endpoints', 'kube-apiserver', '-o', 'json',
  ], {})
  if (epResult.ok) {
    try {
      // Output is newline-delimited JSON objects — parse the first that has addresses
      for (const line of epResult.out.split('\n')) {
        const obj = JSON.parse(line.trim())
        const addresses: string[] = obj?.spec?.addresses ?? []
        if (addresses.length > 0) {
          const apiserverIp = addresses[0]
          // Replace only the server line — preserve all else (certs, user data)
          kubeconfigYaml = kubeconfigYaml.replace(
            /server:\s+https:\/\/[^:]+:6443/,
            `server: https://${apiserverIp}:6443`,
          )
          break
        }
      }
    } catch { /* best-effort — use original if parsing fails */ }
  }

  return kubeconfigYaml
}

async function fetchK3sKubeconfig(nodeIp: string): Promise<string> {
  const result = await runQuiet('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
    `root@${nodeIp}`, 'cat /etc/rancher/k3s/k3s.yaml',
  ], {})
  if (!result.ok) throw new Error(`SSH fetch failed: ${result.out}`)
  return result.out.replace(/server:\s+https:\/\/127\.0\.0\.1:/g, `server: https://${nodeIp}:`)
}

async function gatewayExec(
  gatewayUrl: string, gatewayToken: string,
  toolName: string, args: Record<string, unknown> = {},
): Promise<{ ok: boolean; out: string }> {
  try {
    const res = await fetch(`${gatewayUrl}/tools/execute`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
      body:    JSON.stringify({ name: toolName, arguments: args }),
      signal:  AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, out: `Gateway returned ${res.status}` }
    const data = await res.json() as { result?: string; error?: string }
    if (data.error) return { ok: false, out: data.error }
    return { ok: true, out: data.result ?? '' }
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) }
  }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      const log   = (message: string)          => emit({ type: 'log',   message })
      const check = (c: PreflightCheck)        => emit({ type: 'check', check: c })
      const done  = (payload: Record<string, unknown>) => emit({ type: 'done', ...payload })

      try {
        const env = await prisma.environment.findUnique({ where: { id: params.id } })
        if (!env) { emit({ type: 'error', message: 'Environment not found' }); return }
        if (env.type !== 'cluster') { emit({ type: 'error', message: 'Preflight only applies to cluster environments' }); return }

        const gitOwner = env.gitOwner ?? 'orion'
        const gitRepo  = env.gitRepo ?? env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
        const metadata = (env.metadata ?? {}) as Record<string, unknown>

        log(`Starting preflight for ${env.name}`)

        // ── Fast path: gateway connected ───────────────────────────────────────
        if (env.status === 'connected' && env.gatewayUrl && env.gatewayToken) {
          const gwUrl   = env.gatewayUrl
          const gwToken = env.gatewayToken
          log(`Gateway connected at ${gwUrl} — using it for cluster checks`)

          check({ id: 'connectivity', label: 'Cluster connectivity', status: 'ok', detail: `Gateway connected at ${gwUrl}` })

          // Auto-fetch kubeconfig if missing (needed for Helm/ArgoCD bootstrap)
          if (!env.kubeconfig) {
            log('No kubeconfig stored — fetching via talosctl from host mount')
            const tmpDir = join(tmpdir(), `orion-kube-fetch-${randomBytes(8).toString('hex')}`)
            await mkdir(tmpDir, { recursive: true })
            try {
              const { readFile } = await import('fs/promises')
              const hostConfig     = await readFile('/root/.talos/config', 'utf8')
              const talosconfigB64 = Buffer.from(hostConfig).toString('base64')
              const nodeIpMatch    = gwUrl.match(/https?:\/\/([\d.]+)/)
              const nodeIp         = (metadata.nodeIp as string | undefined) ?? nodeIpMatch?.[1]
              if (nodeIp) {
                log(`Running: talosctl kubeconfig --nodes ${nodeIp}`)
                const kubeconfigYaml = await fetchTalosKubeconfig(nodeIp, talosconfigB64, tmpDir)
                await prisma.environment.update({ where: { id: env.id }, data: { kubeconfig: Buffer.from(kubeconfigYaml).toString('base64') } })
                log('Kubeconfig stored')
                check({ id: 'kubeconfig', label: 'Kubeconfig', status: 'ok', detail: 'Fetched from Talos cluster via talosctl' })
              } else {
                log('Warning: could not determine node IP from gateway URL — skipping kubeconfig fetch')
              }
            } catch (e) {
              log(`Warning: talosctl failed — ${e instanceof Error ? e.message : String(e)}`)
            } finally {
              await rm(tmpDir, { recursive: true, force: true })
            }
          } else {
            check({ id: 'kubeconfig', label: 'Kubeconfig', status: 'ok', detail: 'Already stored' })
          }

          // Node count
          log('Checking node status via gateway')
          const nodes      = await gatewayExec(gwUrl, gwToken, 'kubectl_get_nodes', { wide: false })
          const nodeLines  = nodes.out.split('\n').filter(l => l.trim() && !l.startsWith('NAME'))
          const readyNodes = nodeLines.filter(l => l.includes('Ready')).length
          check({
            id: 'nodes', label: 'Cluster nodes',
            status: readyNodes > 0 ? 'ok' : 'error',
            detail: nodes.ok ? `${readyNodes} of ${nodeLines.length} nodes Ready` : `Could not list nodes: ${nodes.out}`,
          })

          // ArgoCD
          log('Checking ArgoCD')
          const argoNs = await gatewayExec(gwUrl, gwToken, 'kubectl_get', { resource: 'namespace', name: 'argocd' })
          if (!argoNs.ok) {
            check({ id: 'argocd', label: 'ArgoCD', status: 'missing', detail: 'Not installed — will be deployed via Helm' })
          } else {
            const argoSvr = await gatewayExec(gwUrl, gwToken, 'kubectl_get', { resource: 'deployment', name: 'argocd-server', namespace: 'argocd' })
            const match   = argoSvr.out.match(/(\d+)\/(\d+)/)
            check({
              id: 'argocd', label: 'ArgoCD',
              status: argoSvr.ok ? 'ok' : 'missing',
              detail: argoSvr.ok ? `Already installed — ${match ? `${match[1]}/${match[2]} replicas ready` : 'running'}` : 'Namespace exists but argocd-server not found — will install',
            })
          }

          check({ id: 'gateway', label: 'ORION Gateway', status: 'ok', detail: `Connected — ${gwUrl}` })

          // Git repo
          log('Checking git repository')
          try {
            const provider = await getGitProvider()
            const healthy  = await provider.isHealthy()
            if (!healthy) {
              check({ id: 'gitrepo', label: 'Git repository', status: 'skipped', detail: 'Git provider unreachable — skipping' })
            } else {
              await provider.ensureRepo({ owner: gitOwner, name: gitRepo, description: '', private: false }).catch(() => null)
              check({ id: 'gitrepo', label: 'Git repository', status: 'ok', detail: `${gitOwner}/${gitRepo} — ready` })
            }
          } catch {
            check({ id: 'gitrepo', label: 'Git repository', status: 'skipped', detail: 'Git provider not configured' })
          }

          log('Preflight complete')
          done({ canBootstrap: true, gitOwner, gitRepo })
          return
        }

        // ── Credential-based path (no gateway yet) ─────────────────────────────
        if (!env.kubeconfig) {
          const nodeIp = metadata.nodeIp as string | undefined
          if (!nodeIp) {
            check({ id: 'credentials', label: 'Cluster credentials', status: 'missing', detail: 'No control plane node IP configured — edit environment settings.' })
            done({ canBootstrap: false, gitOwner, gitRepo, credentialNeeded: 'nodeIp' })
            return
          }

          log(`Probing ${nodeIp} to detect cluster type`)
          const flavor = await detectClusterFlavor(nodeIp)
          log(`Detected: ${flavor}`)

          if (flavor === 'unreachable') {
            check({ id: 'connectivity', label: 'Cluster reachability', status: 'error', detail: `Cannot reach ${nodeIp} on port 50000 or 6443` })
            done({ canBootstrap: false, gitOwner, gitRepo, clusterFlavor: 'unreachable' })
            return
          }

          check({ id: 'detecting', label: 'Cluster type', status: 'ok', detail: flavor === 'talos' ? `Talos cluster at ${nodeIp}` : `K3s/K8s cluster at ${nodeIp}` })

          if (flavor === 'talos') {
            let talosconfigB64 = metadata.talosconfig as string | undefined
            if (!talosconfigB64) {
              try {
                const { readFile } = await import('fs/promises')
                talosconfigB64 = Buffer.from(await readFile('/root/.talos/config', 'utf8')).toString('base64')
                log('Loaded talosconfig from host')
              } catch { /* not available */ }
            }
            if (!talosconfigB64) {
              check({ id: 'credentials', label: 'Talosconfig', status: 'missing', detail: 'Paste your talosconfig below to auto-fetch the kubeconfig.' })
              done({ canBootstrap: false, gitOwner, gitRepo, clusterFlavor: 'talos', credentialNeeded: 'talosconfig' })
              return
            }
            const tmpDir = join(tmpdir(), `orion-talos-${randomBytes(8).toString('hex')}`)
            await mkdir(tmpDir, { recursive: true })
            try {
              log(`Running: talosctl kubeconfig --nodes ${nodeIp}`)
              const kubeconfigYaml = await fetchTalosKubeconfig(nodeIp, talosconfigB64, tmpDir)
              await prisma.environment.update({ where: { id: env.id }, data: { kubeconfig: Buffer.from(kubeconfigYaml).toString('base64') } })
              log('Kubeconfig stored')
              check({ id: 'credentials', label: 'Kubeconfig', status: 'ok', detail: 'Fetched from Talos cluster via talosctl' })
              const updated = await prisma.environment.findUnique({ where: { id: env.id } })
              if (updated) Object.assign(env, updated)
            } catch (e) {
              check({ id: 'credentials', label: 'Kubeconfig fetch', status: 'error', detail: `talosctl failed: ${e instanceof Error ? e.message : String(e)}` })
              done({ canBootstrap: false, gitOwner, gitRepo, clusterFlavor: 'talos' })
              return
            } finally {
              await rm(tmpDir, { recursive: true, force: true })
            }
          }

          if (flavor === 'k3s') {
            try {
              log(`Fetching kubeconfig from ${nodeIp} via SSH`)
              const kubeconfigYaml = await fetchK3sKubeconfig(nodeIp)
              await prisma.environment.update({ where: { id: env.id }, data: { kubeconfig: Buffer.from(kubeconfigYaml).toString('base64') } })
              log('Kubeconfig stored')
              check({ id: 'credentials', label: 'Kubeconfig', status: 'ok', detail: `Fetched from ${nodeIp} via SSH` })
              const updated = await prisma.environment.findUnique({ where: { id: env.id } })
              if (updated) Object.assign(env, updated)
            } catch (e) {
              check({ id: 'credentials', label: 'Kubeconfig', status: 'missing', detail: `SSH fetch failed: ${e instanceof Error ? e.message : String(e)}` })
              done({ canBootstrap: false, gitOwner, gitRepo, clusterFlavor: 'unknown', credentialNeeded: 'kubeconfig' })
              return
            }
          }
        }

        // ── kubectl checks with stored kubeconfig ──────────────────────────────
        const tmpDir = join(tmpdir(), `orion-preflight-${randomBytes(8).toString('hex')}`)
        await mkdir(tmpDir, { recursive: true })
        const kubeconfigPath = join(tmpDir, 'kubeconfig')

        try {
          await writeFile(kubeconfigPath, Buffer.from(env.kubeconfig!, 'base64').toString('utf8'), { mode: 0o600 })
          const kenv = { KUBECONFIG: kubeconfigPath }

          log('Checking cluster connectivity')
          const connectivity = await runQuiet('kubectl', ['cluster-info', '--request-timeout=5s'], kenv)
          check({
            id: 'connectivity', label: 'Cluster connectivity',
            status: connectivity.ok ? 'ok' : 'error',
            detail: connectivity.ok ? (connectivity.out.split('\n')[0] ?? 'Connected') : `Cannot reach cluster: ${connectivity.out.split('\n')[0] ?? 'timeout'}`,
          })
          if (!connectivity.ok) { done({ canBootstrap: false, gitOwner, gitRepo }); return }

          log('Checking nodes')
          const nodes      = await runQuiet('kubectl', ['get', 'nodes', '--no-headers'], kenv)
          const nodeLines  = nodes.out.split('\n').filter(Boolean)
          const readyNodes = nodeLines.filter(l => l.includes(' Ready ')).length
          check({ id: 'nodes', label: 'Cluster nodes', status: readyNodes > 0 ? 'ok' : 'error', detail: `${readyNodes} of ${nodeLines.length} nodes Ready` })

          log('Checking ArgoCD')
          const argoNs = await runQuiet('kubectl', ['get', 'namespace', 'argocd', '--no-headers'], kenv)
          if (!argoNs.ok) {
            check({ id: 'argocd', label: 'ArgoCD', status: 'missing', detail: 'Not installed — will be deployed via Helm' })
          } else {
            const argoSvr = await runQuiet('kubectl', ['get', 'deployment', 'argocd-server', '-n', 'argocd', '--no-headers'], kenv)
            const match   = argoSvr.out.match(/(\d+)\/(\d+)/)
            check({ id: 'argocd', label: 'ArgoCD', status: argoSvr.ok ? 'ok' : 'missing', detail: argoSvr.ok ? `Already installed — ${match ? `${match[1]}/${match[2]} replicas ready` : 'running'}` : 'Namespace exists but argocd-server not found — will install' })
          }

          log('Checking ORION Gateway deployment')
          const gwDeploy = await runQuiet('kubectl', ['get', 'deployment', 'orion-gateway', '-n', 'orion-management', '--no-headers'], kenv)
          if (gwDeploy.ok) {
            const match = gwDeploy.out.match(/(\d+)\/(\d+)/)
            check({ id: 'gateway', label: 'ORION Gateway', status: 'ok', detail: `Already deployed — ${match ? `${match[1]}/${match[2]} replicas ready` : 'running'}` })
          } else {
            check({ id: 'gateway', label: 'ORION Gateway', status: 'missing', detail: 'Not deployed — will deploy into orion-management namespace' })
          }

          log('Checking git repository')
          try {
            const provider = await getGitProvider()
            const healthy  = await provider.isHealthy()
            if (!healthy) {
              check({ id: 'gitrepo', label: 'Git repository', status: 'skipped', detail: 'Git provider unreachable — skipping' })
            } else {
              await provider.ensureRepo({ owner: gitOwner, name: gitRepo, description: '', private: false }).catch(() => null)
              check({ id: 'gitrepo', label: 'Git repository', status: 'ok', detail: `${gitOwner}/${gitRepo} — ready` })
            }
          } catch {
            check({ id: 'gitrepo', label: 'Git repository', status: 'skipped', detail: 'Git provider not configured' })
          }

          const allChecks = ['connectivity', 'nodes', 'argocd', 'gateway', 'gitrepo']
          log('Preflight complete')
          done({ canBootstrap: true, gitOwner, gitRepo })

        } finally {
          await rm(tmpDir, { recursive: true, force: true })
        }

      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  })
}
