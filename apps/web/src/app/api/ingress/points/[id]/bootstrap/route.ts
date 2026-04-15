/**
 * POST /api/ingress/points/:id/bootstrap
 *
 * Bootstraps an IngressPoint by deploying Traefik + cert-manager into the
 * associated environment via the Gateway.
 *
 * Streams SSE progress events:
 *   { type: 'log',  message: string }
 *   { type: 'done', success: boolean, error?: string }
 */
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'

function sse(controller: ReadableStreamDefaultController, event: object) {
  controller.enqueue(`data: ${JSON.stringify(event)}\n\n`)
}

function log(ctrl: ReadableStreamDefaultController, msg: string) {
  console.log('[ingress-bootstrap]', msg)
  sse(ctrl, { type: 'log', message: msg })
}

async function gatewayExec(
  gatewayUrl: string,
  gatewayToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${gatewayUrl}/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
    body: JSON.stringify({ name: toolName, arguments: args }),
  })
  if (!res.ok) throw new Error(`Gateway tool ${toolName} failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as { result?: string; error?: string }
  if (data.error) throw new Error(data.error)
  return data.result ?? ''
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const point = await prisma.ingressPoint.findUnique({
    where: { id: params.id },
    include: {
      domain:      true,
      environment: true,
      middlewares: true,
    },
  })
  if (!point) {
    return new Response(JSON.stringify({ error: 'IngressPoint not found' }), { status: 404 })
  }
  if (!point.environment) {
    return new Response(JSON.stringify({ error: 'IngressPoint has no associated environment' }), { status: 422 })
  }

  const env = point.environment
  if (!env.gatewayUrl || !env.gatewayToken) {
    return new Response(JSON.stringify({ error: 'Environment gateway not connected' }), { status: 422 })
  }

  const isDocker = env.type === 'docker'

  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        log(ctrl, `Bootstrapping IngressPoint "${point.name}" in environment "${env.name}" (${isDocker ? 'Docker' : 'Kubernetes'})`)

        let assignedIp = point.ip

        if (isDocker) {
          // ── Docker: deploy Traefik as a container ─────────────────────────
          log(ctrl, 'Step 1/1: Deploying Traefik container...')

          const httpPort  = 80
          const httpsPort = point.port
          const traefikArgs = [
            '--api.dashboard=true',
            '--providers.docker=true',
            '--providers.docker.exposedByDefault=false',
            `--entryPoints.web.address=:${httpPort}`,
            `--entryPoints.websecure.address=:${httpsPort}`,
          ]
          if (point.certManager) {
            traefikArgs.push(
              '--certificatesResolvers.letsencrypt.acme.tlsChallenge=true',
              `--certificatesResolvers.letsencrypt.acme.email=admin@${point.domain.name}`,
              '--certificatesResolvers.letsencrypt.acme.storage=/letsencrypt/acme.json',
            )
          }

          await gatewayExec(env.gatewayUrl!, env.gatewayToken!, 'docker_run', {
            image:   'traefik:v3',
            name:    'traefik',
            restart: 'unless-stopped',
            ports:   [`${httpPort}:${httpPort}`, `${httpsPort}:${httpsPort}`, '8080:8080'],
            volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro', 'traefik-letsencrypt:/letsencrypt'],
            args:    traefikArgs,
            detach:  true,
          })
          log(ctrl, '  Traefik container started ✓')

          if (point.ip) {
            assignedIp = point.ip
          }
        } else {
          // ── Kubernetes: cert-manager → ClusterIssuer → Traefik Helm ───────

          // Step 1: cert-manager
          log(ctrl, 'Step 1/3: Installing cert-manager...')
          let certManagerExists = false
          try {
            await gatewayExec(env.gatewayUrl!, env.gatewayToken!, 'kubectl_get', {
              resource: 'namespace', name: 'cert-manager',
            })
            certManagerExists = true
            log(ctrl, '  cert-manager already installed ✓')
          } catch {
            certManagerExists = false
          }

          if (!certManagerExists) {
            log(ctrl, '  Applying cert-manager manifests...')
            await gatewayExec(env.gatewayUrl!, env.gatewayToken!, 'kubectl_apply_url', {
              url: 'https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml',
            })
            log(ctrl, '  Waiting for cert-manager webhook to be ready...')
            await gatewayExec(env.gatewayUrl!, env.gatewayToken!, 'kubectl_rollout_status', {
              kind: 'deployment', name: 'cert-manager-webhook', namespace: 'cert-manager', timeout: '120s',
            })
            log(ctrl, '  cert-manager ready ✓')
          }

          // Step 2: ClusterIssuer
          if (point.certManager && point.clusterIssuer) {
            log(ctrl, `Step 2/3: Configuring ClusterIssuer "${point.clusterIssuer}"...`)
            const issuerYaml = buildClusterIssuer(point.clusterIssuer, point.domain.name)
            await gatewayExec(env.gatewayUrl!, env.gatewayToken!, 'kubectl_apply_manifest', {
              manifest: issuerYaml,
            })
            log(ctrl, `  ClusterIssuer "${point.clusterIssuer}" applied ✓`)
          } else {
            log(ctrl, 'Step 2/3: Skipping ClusterIssuer (cert-manager disabled or no issuer configured)')
          }

          // Step 3: Traefik via Helm
          log(ctrl, 'Step 3/3: Installing Traefik via Helm...')
          const helmValues: Record<string, string> = {
            'ports.websecure.port': String(point.port),
            'ports.web.port':       '80',
          }
          if (point.ip) {
            helmValues['service.loadBalancerIP'] = point.ip
          }
          if (point.certManager) {
            helmValues['ingressClass.enabled']        = 'true'
            helmValues['ingressClass.isDefaultClass'] = 'true'
          }

          await gatewayExec(env.gatewayUrl!, env.gatewayToken!, 'helm_upgrade_install', {
            release:         'traefik',
            chart:           'traefik',
            repo:            'https://helm.traefik.io/traefik',
            namespace:       'kube-system',
            createNamespace: false,
            values:          helmValues,
            wait:            true,
            timeout:         '180s',
          })
          log(ctrl, '  Traefik installed ✓')

          // Discover the assigned LoadBalancer IP
          try {
            const svcJson = await gatewayExec(env.gatewayUrl!, env.gatewayToken!, 'kubectl_get', {
              resource: 'service', name: 'traefik', namespace: 'kube-system', output: 'json',
            })
            const svc = JSON.parse(svcJson)
            const ingresses = svc?.status?.loadBalancer?.ingress ?? []
            const discovered = ingresses[0]?.ip ?? ingresses[0]?.hostname ?? null
            if (discovered && discovered !== assignedIp) {
              assignedIp = discovered
              log(ctrl, `  Discovered LoadBalancer IP: ${assignedIp}`)
            }
          } catch { /* non-fatal */ }
        }

        // ── Mark bootstrapped ───────────────────────────────────────────────
        await prisma.ingressPoint.update({
          where: { id: params.id },
          data:  { status: 'bootstrapped', ...(assignedIp ? { ip: assignedIp } : {}) },
        })

        const addr = assignedIp ? `${assignedIp}:${point.port}` : `port ${point.port} (no external IP yet)`
        log(ctrl, `Bootstrap complete! Traefik is serving at ${addr}`)
        sse(ctrl, { type: 'done', success: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(ctrl, `Bootstrap failed: ${msg}`)
        sse(ctrl, { type: 'done', success: false, error: msg })
        await prisma.ingressPoint.update({
          where: { id: params.id },
          data:  { status: 'error' },
        })
      } finally {
        ctrl.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection:      'keep-alive',
    },
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildClusterIssuer(name: string, _domain: string): string {
  // Generic ACME staging/prod issuer — user configures DNS credentials separately
  const server = name.includes('staging')
    ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
    : 'https://acme-v02.api.letsencrypt.org/directory'

  return `apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: ${name}
spec:
  acme:
    server: ${server}
    email: admin@local
    privateKeySecretRef:
      name: ${name}-key
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token`
}

function buildTraefikValues(ip: string | null, port: number, _clusterIssuer: string | null): string {
  return JSON.stringify({ loadBalancerIP: ip, port })
}
