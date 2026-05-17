/**
 * Seeds the system Nebula — a git repo in ORION's configured git provider
 * containing default Nova definitions for middleware bootstrapping.
 *
 * Called after the git provider is configured (setup wizard step 3).
 * If the system Nebula already exists, triggers a re-sync instead.
 */

import { getGitProvider, getGitProviderConfig } from './git-provider'
import { prisma } from './db'
import { syncNebula } from './nebula-loader'

const SYSTEM_NEBULA_REPO = 'orion-nebula'

const DEFAULT_NOVA_FILES: Record<string, string> = {
  'novas/crowdsec.yaml': `name: crowdsec
displayName: CrowdSec
description: Behavioral IPS with Traefik bouncer for automated IP banning
tags: [middleware, security]
category: Middleware
type: service
icon: Shield
helm:
  chart: crowdsec
  repo: https://crowdsecurity.github.io/helm-charts
  namespace: crowdsec
  createNamespace: true
  values: |
    agent:
      acquisition:
        - namespace: kube-system
          podName: ".*"
          program: containerlog
        - namespace: apps
          podName: ".*"
          program: containerlog
        - namespace: security
          podName: ".*"
          program: containerlog
        - namespace: management
          podName: ".*"
          program: containerlog
    lapi:
      dashboard:
        enabled: false
namespaceLabels:
  crowdsec:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/audit: privileged
    pod-security.kubernetes.io/warn: privileged
postInstall:
  - manifest: |
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: crowdsec-traefik-bouncer
        namespace: crowdsec
      spec:
        replicas: 1
        selector:
          matchLabels:
            app: crowdsec-traefik-bouncer
        template:
          metadata:
            labels:
              app: crowdsec-traefik-bouncer
          spec:
            containers:
              - name: bouncer
                image: docker.io/fbonalair/traefik-crowdsec-bouncer:latest
                env:
                  - name: CROWDSEC_BOUNCER_API_KEY
                    valueFrom:
                      secretKeyRef:
                        name: crowdsec-traefik-bouncer
                        key: api_key
                  - name: CROWDSEC_AGENT_HOST
                    value: crowdsec-service.crowdsec.svc.cluster.local:8080
                ports:
                  - containerPort: 8068
      ---
      apiVersion: v1
      kind: Service
      metadata:
        name: crowdsec-traefik-bouncer
        namespace: crowdsec
      spec:
        selector:
          app: crowdsec-traefik-bouncer
        ports:
          - name: http
            port: 8068
            targetPort: 8068
      ---
      apiVersion: traefik.io/v1alpha1
      kind: Middleware
      metadata:
        name: crowdsec-bouncer
        namespace: security
      spec:
        forwardAuth:
          address: http://crowdsec-traefik-bouncer.crowdsec.svc.cluster.local:8068/api/v1/forwardAuth
          trustForwardHeader: true
setupNote: |
  After install, generate the bouncer API key:
    kubectl exec -n crowdsec deploy/crowdsec-lapi -- cscli bouncers add traefik-bouncer -o raw
  Then patch the secret:
    kubectl create secret generic crowdsec-traefik-bouncer -n crowdsec --from-literal=api_key=<KEY> --dry-run=client -o yaml | kubectl apply -f -
`,

  'novas/rate-limit.yaml': `name: rate-limit
displayName: Rate Limiting
description: Per-IP request rate limiting via Traefik — protects against brute force and scrapers
tags: [middleware, security]
category: Middleware
type: service
icon: Gauge
postInstall:
  - manifest: |
      apiVersion: traefik.io/v1alpha1
      kind: Middleware
      metadata:
        name: rate-limit
        namespace: security
      spec:
        rateLimit:
          average: 100
          burst: 50
          period: 1m
          sourceCriterion:
            ipStrategy:
              depth: 1
`,

  'novas/secure-headers.yaml': `name: secure-headers
displayName: Secure Headers
description: HSTS, X-Frame-Options, CSP, and other security headers applied via Traefik
tags: [middleware, security]
category: Middleware
type: service
icon: ShieldCheck
postInstall:
  - manifest: |
      apiVersion: traefik.io/v1alpha1
      kind: Middleware
      metadata:
        name: secure-headers
        namespace: security
      spec:
        headers:
          stsSeconds: 31536000
          stsIncludeSubdomains: true
          stsPreload: true
          forceSTSHeader: true
          frameDeny: true
          contentTypeNosniff: true
          browserXssFilter: true
          referrerPolicy: strict-origin-when-cross-origin
          customResponseHeaders:
            X-Robots-Tag: "noindex,nofollow,nosnippet,noarchive"
            Server: ""
`,

  'novas/ip-allowlist.yaml': `name: ip-allowlist
displayName: IP Allowlist
description: Restrict access to specific IP ranges — useful for locking down admin services
tags: [middleware, security, access-control]
category: Middleware
type: service
icon: Lock
setupNote: |
  Edit the sourceRange list after install to add your allowed CIDRs:
    kubectl edit middleware ip-allowlist -n security
postInstall:
  - manifest: |
      apiVersion: traefik.io/v1alpha1
      kind: Middleware
      metadata:
        name: ip-allowlist
        namespace: security
      spec:
        ipAllowList:
          sourceRange:
            - 127.0.0.1/32
            - 10.0.0.0/8
            - 192.168.0.0/16
`,

  'novas/basic-auth.yaml': `name: basic-auth
displayName: Basic Auth
description: Simple username/password protection for services not covered by SSO
tags: [middleware, auth]
category: Middleware
type: service
icon: KeyRound
setupNote: |
  Create the auth secret before using:
    kubectl create secret generic basic-auth -n security \\
      --from-literal=users=$(htpasswd -nb admin yourpassword)
postInstall:
  - manifest: |
      apiVersion: traefik.io/v1alpha1
      kind: Middleware
      metadata:
        name: basic-auth
        namespace: security
      spec:
        basicAuth:
          secret: basic-auth
          removeHeader: true
`,
}

export async function seedSystemNebula(): Promise<void> {
  // Check if already seeded
  const existing = await prisma.nebula.findUnique({ where: { name: 'system' } })
  if (existing) {
    // Already exists — trigger a sync to pick up any new default Novas
    await syncNebula(existing.id)
    return
  }

  const config = await getGitProviderConfig()
  if (!config) return // Git not configured yet

  const provider = await getGitProvider()
  const org = config.org

  // Create the orion-nebula repo
  const repo = await provider.ensureRepo({
    owner: org,
    name: SYSTEM_NEBULA_REPO,
    description: 'ORION system Nebula — default Nova definitions',
    private: false,
    isOrg: false,
  })

  // Commit default Nova files
  await provider.commitFiles({
    owner: org,
    repo: SYSTEM_NEBULA_REPO,
    branch: 'main',
    files: Object.entries(DEFAULT_NOVA_FILES).map(([path, content]) => ({ path, content })),
    message: 'chore: seed default middleware Novas',
  })

  // Create Nebula DB record
  const nebula = await prisma.nebula.create({
    data: {
      name: 'system',
      displayName: 'ORION System Nebula',
      description: 'Built-in Nova catalog managed by ORION',
      gitUrl: repo.cloneUrl,
      branch: 'main',
      path: 'novas',
      isSystem: true,
      syncStatus: 'pending',
    },
  })

  // Sync Novas from the repo into the DB
  await syncNebula(nebula.id)
}
