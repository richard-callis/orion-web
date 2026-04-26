/**
 * POST /api/ingress/domains/:id/dns/bootstrap
 *
 * Deploys CoreDNS into the domain's coreDnsEnvironment.
 * K8s  → kubectl manifests (Deployment + Service + ConfigMap)
 * Docker → docker_run coredns/coredns
 *
 * Streams SSE: { type: 'log', message } | { type: 'done', success, error? }
 */
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { buildZoneFile, syncToKubernetes, syncToDocker } from '@/lib/dns-sync'

function sse(ctrl: ReadableStreamDefaultController, event: object) {
  ctrl.enqueue(`data: ${JSON.stringify(event)}\n\n`)
}
function log(ctrl: ReadableStreamDefaultController, msg: string) {
  console.log('[dns-bootstrap]', msg)
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

// ── K8s manifests ─────────────────────────────────────────────────────────────

function buildCoreDnsManifests(domainName: string, ip: string | null, zoneContent: string): string {
  const loadBalancerLine = ip ? `\n  loadBalancerIP: "${ip}"` : ''
  const corefile = `
${domainName}. {
    file /etc/coredns/zones/${domainName}.db
    reload 30s
    log
    errors
}
. {
    forward . 1.1.1.1 8.8.8.8
    cache 30
    errors
}
`.trim()

  const zoneIndented = zoneContent.split('\n').map(l => '    ' + l).join('\n')

  return `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-orion
  namespace: kube-system
  labels:
    app: coredns-orion
    managed-by: orion
data:
  Corefile: |
    ${corefile.split('\n').join('\n    ')}
  ${domainName}.db: |
${zoneIndented}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns-orion
  namespace: kube-system
  labels:
    app: coredns-orion
    managed-by: orion
spec:
  replicas: 1
  selector:
    matchLabels:
      app: coredns-orion
  template:
    metadata:
      labels:
        app: coredns-orion
    spec:
      containers:
      - name: coredns
        image: coredns/coredns:latest
        args: ["-conf", "/etc/coredns/Corefile"]
        ports:
        - containerPort: 53
          protocol: UDP
          name: dns-udp
        - containerPort: 53
          protocol: TCP
          name: dns-tcp
        volumeMounts:
        - name: config
          mountPath: /etc/coredns
        - name: zones
          mountPath: /etc/coredns/zones
      volumes:
      - name: config
        configMap:
          name: coredns-orion
          items:
          - key: Corefile
            path: Corefile
      - name: zones
        configMap:
          name: coredns-orion
          items:
          - key: ${domainName}.db
            path: ${domainName}.db
---
apiVersion: v1
kind: Service
metadata:
  name: coredns-orion
  namespace: kube-system
  labels:
    app: coredns-orion
    managed-by: orion
spec:
  type: LoadBalancer${loadBalancerLine}
  selector:
    app: coredns-orion
  ports:
  - name: dns-udp
    port: 53
    targetPort: 53
    protocol: UDP
  - name: dns-tcp
    port: 53
    targetPort: 53
    protocol: TCP
`
}

// ── Docker Corefile ───────────────────────────────────────────────────────────

function buildDockerCorefile(domainName: string): string {
  return `${domainName}. {
    file /etc/coredns/zones/${domainName}.db
    reload 30s
    log
    errors
}
. {
    forward . 1.1.1.1 8.8.8.8
    cache 30
    errors
}
`
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const domain = await prisma.domain.findUnique({
    where: { id: params.id },
    include: { coreDnsEnvironment: true, dnsRecords: { where: { enabled: true } } },
  })
  if (!domain) return new Response(JSON.stringify({ error: 'Domain not found' }), { status: 404 })
  if (!domain.coreDnsEnvironment) return new Response(JSON.stringify({ error: 'No CoreDNS environment selected' }), { status: 422 })

  const env = domain.coreDnsEnvironment
  if (!env.gatewayUrl || !env.gatewayToken) {
    return new Response(JSON.stringify({ error: 'Environment gateway not connected' }), { status: 422 })
  }

  const exec = (tool: string, args: Record<string, unknown>) =>
    gatewayExec(env.gatewayUrl!, env.gatewayToken!, tool, args)

  const isDocker = env.type === 'docker'
  const zoneContent = buildZoneFile(
    domain.name,
    domain.dnsRecords.map((r: any) => ({ ip: r.ip, hostnames: r.hostnames })),
  )

  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        log(ctrl, `Bootstrapping CoreDNS for "${domain.name}" in "${env.name}" (${isDocker ? 'Docker' : 'Kubernetes'})`)

        let assignedIp = domain.coreDnsIp

        if (isDocker) {
          // ── Docker path ──────────────────────────────────────────────────
          log(ctrl, 'Step 1/2: Starting CoreDNS container...')
          const corefile = buildDockerCorefile(domain.name)
          const corefileEscaped = corefile.replace(/'/g, `'"'"'`)

          // Write Corefile
          await exec('docker_exec', {
            container: 'coredns',
            command:   `sh -c 'echo exists'`,
          }).catch(async () => {
            // Container doesn't exist — run it
            await exec('docker_run', {
              image:   'coredns/coredns:latest',
              name:    'coredns',
              restart: 'unless-stopped',
              ports:   ['53:53/udp', '53:53/tcp'],
              volumes: ['coredns-zones:/etc/coredns/zones', 'coredns-config:/etc/coredns'],
              detach:  true,
            })
          })

          log(ctrl, '  Writing Corefile...')
          await exec('docker_exec', {
            container: 'coredns',
            command:   `sh -c 'printf '"'"'${corefileEscaped}'"'"' > /etc/coredns/Corefile'`,
          })

          log(ctrl, '  Writing zone file...')
          await syncToDocker(exec, domain.name, zoneContent)
          log(ctrl, '  CoreDNS container running ✓')

          if (domain.coreDnsIp) assignedIp = domain.coreDnsIp

        } else {
          // ── Kubernetes path ──────────────────────────────────────────────
          log(ctrl, 'Step 1/2: Applying CoreDNS manifests...')
          const manifests = buildCoreDnsManifests(domain.name, domain.coreDnsIp, zoneContent)
          await exec('kubectl_apply_manifest', { manifest: manifests })
          log(ctrl, '  Manifests applied ✓')

          log(ctrl, 'Step 2/2: Waiting for CoreDNS to be ready...')
          await exec('kubectl_rollout_status', {
            kind: 'deployment', name: 'coredns-orion', namespace: 'kube-system', timeout: '120s',
          })
          log(ctrl, '  CoreDNS ready ✓')

          // Discover assigned LoadBalancer IP
          try {
            const svcJson = await exec('kubectl_get', {
              resource: 'service', name: 'coredns-orion', namespace: 'kube-system', output: 'json',
            })
            const svc = JSON.parse(svcJson)
            const ingresses = svc?.status?.loadBalancer?.ingress ?? []
            const discovered = ingresses[0]?.ip ?? ingresses[0]?.hostname ?? null
            if (discovered) {
              assignedIp = discovered
              log(ctrl, `  Discovered LoadBalancer IP: ${assignedIp}`)
            }
          } catch { /* non-fatal */ }
        }

        await prisma.domain.update({
          where: { id: params.id },
          data: { coreDnsStatus: 'bootstrapped', ...(assignedIp ? { coreDnsIp: assignedIp } : {}) },
        })

        const addr = assignedIp ? `${assignedIp}:53` : 'port 53 (no external IP yet)'
        log(ctrl, `Bootstrap complete! CoreDNS is serving ${domain.name} at ${addr}`)
        sse(ctrl, { type: 'done', success: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(ctrl, `Bootstrap failed: ${msg}`)
        sse(ctrl, { type: 'done', success: false, error: msg })
        await prisma.domain.update({ where: { id: params.id }, data: { coreDnsStatus: 'error' } })
      } finally {
        ctrl.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  })
}
