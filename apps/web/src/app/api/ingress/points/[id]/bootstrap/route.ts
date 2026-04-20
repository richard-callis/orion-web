/**
 * POST /api/ingress/points/:id/bootstrap
 *
 * Bootstraps an IngressPoint by deploying Traefik + cert-manager into the
 * associated environment via the Gateway.
 *
 * Returns { jobId } immediately — progress tracked via /api/jobs/[id].
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { startJob, type JobLogger } from '@/lib/job-runner'
import { GatewayClient } from '@/lib/agent-runner/gateway-client'

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
    return NextResponse.json({ error: 'IngressPoint not found' }, { status: 404 })
  }
  if (!point.environment) {
    return NextResponse.json({ error: 'IngressPoint has no associated environment' }, { status: 422 })
  }

  const env = point.environment
  if (!env.gatewayUrl || !env.gatewayToken) {
    return NextResponse.json({ error: 'Environment gateway not connected' }, { status: 422 })
  }

  const isDocker = env.type === 'docker'

  const jobId = await startJob(
    'ingress-bootstrap',
    `Ingress bootstrap — ${point.name} (${env.name})`,
    { environmentId: env.id, metadata: { pointId: point.id, pointName: point.name } },
    async (log) => {
      await bootstrapIngressPoint(log, point, env, isDocker, params.id)
    },
  )

  return NextResponse.json({ jobId })
}

async function bootstrapIngressPoint(
  log: JobLogger,
  point: {
    id: string
    name: string
    ip: string | null
    port: number
    certManager: boolean
    clusterIssuer: string | null
    domain: { name: string }
    environment?: { id: string; name: string; type: string; gatewayUrl: string | null; gatewayToken: string | null } | null
  },
  env: { id: string; name: string; type: string; gatewayUrl: string | null; gatewayToken: string | null },
  isDocker: boolean,
  pointId: string,
): Promise<void> {
  const gc = new GatewayClient(env.gatewayUrl!, env.gatewayToken!)
  const gatewayExec = (toolName: string, args: Record<string, unknown>) => gc.executeTool(toolName, args)

  await log(`Bootstrapping IngressPoint "${point.name}" in environment "${env.name}" (${isDocker ? 'Docker' : 'Kubernetes'})`)

  let assignedIp = point.ip

  if (isDocker) {
    // ── Docker: deploy Traefik as a container ─────────────────────────
    await log('Step 1/1: Deploying Traefik container...')

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

    await gatewayExec('docker_run', {
      image:   'traefik:v3',
      name:    'traefik',
      restart: 'unless-stopped',
      ports:   [`${httpPort}:${httpPort}`, `${httpsPort}:${httpsPort}`, '8080:8080'],
      volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro', 'traefik-letsencrypt:/letsencrypt'],
      args:    traefikArgs,
      detach:  true,
    })
    await log('  Traefik container started ✓')

    if (point.ip) {
      assignedIp = point.ip
    }
  } else {
    // ── Kubernetes: MetalLB → cert-manager → ClusterIssuer → Traefik Helm ───────

    if (!point.ip) {
      throw new Error('An IP address is required for Kubernetes ingress bootstrap. Set a LoadBalancer IP on this IngressPoint before bootstrapping.')
    }

    // Step 1: MetalLB
    await log('Step 1/4: Installing MetalLB...')
    let metallbExists = false
    try {
      await gatewayExec('kubectl_get', {
        resource: 'namespace', name: 'metallb-system',
      })
      metallbExists = true
      await log('  MetalLB already installed ✓')
    } catch {
      metallbExists = false
    }

    if (!metallbExists) {
      await log('  Applying MetalLB manifests...')
      await gatewayExec('kubectl_apply_url', {
        url: 'https://raw.githubusercontent.com/metallb/metallb/v0.14.9/config/manifests/metallb-native.yaml',
      })
      await log('  Waiting for MetalLB controller to be ready...')
      await gatewayExec('kubectl_rollout_status', {
        kind: 'deployment', name: 'controller', namespace: 'metallb-system', timeout: '120s',
      })
      await log('  MetalLB ready ✓')
    }

    await log(`  Configuring IPAddressPool for ${point.ip}...`)
    await gatewayExec('kubectl_apply_manifest', {
      manifest: buildMetalLBConfig(point.ip),
    })
    await log('  MetalLB IP pool configured ✓')

    // Step 2: cert-manager
    await log('Step 2/4: Installing cert-manager...')
    let certManagerExists = false
    try {
      await gatewayExec('kubectl_get', {
        resource: 'namespace', name: 'cert-manager',
      })
      certManagerExists = true
      await log('  cert-manager already installed ✓')
    } catch {
      certManagerExists = false
    }

    if (!certManagerExists) {
      await log('  Applying cert-manager manifests...')
      await gatewayExec('kubectl_apply_url', {
        url: 'https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml',
      })
      await log('  Waiting for cert-manager webhook to be ready...')
      await gatewayExec('kubectl_rollout_status', {
        kind: 'deployment', name: 'cert-manager-webhook', namespace: 'cert-manager', timeout: '120s',
      })
      await log('  cert-manager ready ✓')
    }

    // Step 3: ClusterIssuer
    if (point.certManager && point.clusterIssuer) {
      await log(`Step 3/4: Configuring ClusterIssuer "${point.clusterIssuer}"...`)
      const issuerYaml = buildClusterIssuer(point.clusterIssuer, point.domain.name)
      await gatewayExec('kubectl_apply_manifest', {
        manifest: issuerYaml,
      })
      await log(`  ClusterIssuer "${point.clusterIssuer}" applied ✓`)
    } else {
      await log('Step 3/4: Skipping ClusterIssuer (cert-manager disabled or no issuer configured)')
    }

    // Step 4: Traefik via Helm
    await log('Step 4/4: Installing Traefik via Helm...')
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

    await gatewayExec('helm_upgrade_install', {
      release:         'traefik',
      chart:           'traefik',
      repo:            'https://helm.traefik.io/traefik',
      namespace:       'kube-system',
      createNamespace: false,
      values:          helmValues,
      wait:            true,
      timeout:         '180s',
    })
    await log('  Traefik installed ✓')

    // Discover the assigned LoadBalancer IP
    try {
      const svcJson = await gatewayExec('kubectl_get', {
        resource: 'service', name: 'traefik', namespace: 'kube-system', output: 'json',
      })
      const svc = JSON.parse(svcJson)
      const ingresses = svc?.status?.loadBalancer?.ingress ?? []
      const discovered = ingresses[0]?.ip ?? ingresses[0]?.hostname ?? null
      if (discovered && discovered !== assignedIp) {
        assignedIp = discovered
        await log(`  Discovered LoadBalancer IP: ${assignedIp}`)
      }
    } catch { /* non-fatal */ }
  }

  // ── Mark bootstrapped ───────────────────────────────────────────────
  await prisma.ingressPoint.update({
    where: { id: pointId },
    data:  { status: 'bootstrapped', ...(assignedIp ? { ip: assignedIp } : {}) },
  })

  const addr = assignedIp ? `${assignedIp}:${point.port}` : `port ${point.port} (no external IP yet)`
  await log(`Bootstrap complete! Traefik is serving at ${addr}`)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMetalLBConfig(ip: string): string {
  return `apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: orion-pool
  namespace: metallb-system
spec:
  addresses:
    - ${ip}/32
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: orion-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - orion-pool`
}

function buildClusterIssuer(name: string, domain: string): string {
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
    email: admin@${domain}
    privateKeySecretRef:
      name: ${name}-key
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token`
}
