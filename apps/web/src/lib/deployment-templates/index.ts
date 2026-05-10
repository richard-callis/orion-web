/**
 * Deployment template registry.
 *
 * Generic Kubernetes building blocks agents use as starting points.
 * Each template has clearly marked {{ PLACEHOLDER }} fields and comments
 * explaining every option — agents fill in what they need, remove what
 * they don't, and propose the result to Gitea via gitops_propose.
 *
 * During bootstrap, all templates are pushed to the configured Gitea repo
 * so they live alongside the cluster manifests.
 *
 * Placeholder convention:
 *   {{ PLACEHOLDER }}   — required, must be replaced
 *   {{ PLACEHOLDER? }}  — optional, remove the line if not needed
 */

export interface DeploymentTemplate {
  name:        string
  category:    'core' | 'workload' | 'networking' | 'storage' | 'secrets' | 'gitops'
  description: string
  yaml:        string
}

export const DEPLOYMENT_TEMPLATES: DeploymentTemplate[] = [

  // ── Core ───────────────────────────────────────────────────────────────────

  {
    name:     'namespace',
    category: 'core',
    description: 'Kubernetes Namespace with standard labels. Always the first resource to create for a new service.',
    yaml: `\
apiVersion: v1
kind: Namespace
metadata:
  name: {{ NAMESPACE }}            # e.g. "tailscale", "monitoring", "apps"
  labels:
    app.kubernetes.io/name: {{ APP_NAME }}
    app.kubernetes.io/managed-by: orion
`,
  },

  // ── Workloads ──────────────────────────────────────────────────────────────

  {
    name:     'deployment',
    category: 'workload',
    description: 'Standard Deployment for stateless services. Includes resource limits, optional health checks, and node affinity for amd64-only images.',
    yaml: `\
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  labels:
    app: {{ APP_NAME }}
spec:
  replicas: 1                      # increase for HA; use HPA for autoscaling
  selector:
    matchLabels:
      app: {{ APP_NAME }}
  template:
    metadata:
      labels:
        app: {{ APP_NAME }}
    spec:
      containers:
        - name: {{ APP_NAME }}
          image: {{ IMAGE }}        # e.g. "ghcr.io/org/app:v1.2.3" — pin to a digest for production
          ports:
            - containerPort: {{ PORT }}
          env: []                  # add env vars here or envFrom a Secret

          # Reference a Secret created by an ExternalSecret:
          # envFrom:
          #   - secretRef:
          #       name: {{ APP_NAME }}-secret

          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m             # set based on observed usage
              memory: 512Mi

          # Uncomment when the app exposes a health endpoint:
          # livenessProbe:
          #   httpGet: { path: /health, port: {{ PORT }} }
          #   initialDelaySeconds: 30
          #   periodSeconds: 10
          # readinessProbe:
          #   httpGet: { path: /ready, port: {{ PORT }} }
          #   initialDelaySeconds: 5
          #   periodSeconds: 5

      # Uncomment to restrict to amd64 nodes (RPi nodes are arm64):
      # affinity:
      #   nodeAffinity:
      #     requiredDuringSchedulingIgnoredDuringExecution:
      #       nodeSelectorTerms:
      #         - matchExpressions:
      #             - { key: kubernetes.io/arch, operator: In, values: [amd64] }
`,
  },

  {
    name:     'statefulset',
    category: 'workload',
    description: 'StatefulSet for services that need stable identity or persistent storage (databases, message queues, stateful operators).',
    yaml: `\
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  labels:
    app: {{ APP_NAME }}
spec:
  serviceName: {{ APP_NAME }}      # must match a headless Service
  replicas: 1
  selector:
    matchLabels:
      app: {{ APP_NAME }}
  template:
    metadata:
      labels:
        app: {{ APP_NAME }}
    spec:
      containers:
        - name: {{ APP_NAME }}
          image: {{ IMAGE }}
          ports:
            - containerPort: {{ PORT }}
          env: []

          volumeMounts:
            - name: data
              mountPath: {{ MOUNT_PATH }}  # e.g. "/data", "/var/lib/postgresql"

          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: longhorn        # cluster default — use longhorn for HA replicas
        resources:
          requests:
            storage: {{ STORAGE_SIZE }}   # e.g. "10Gi", "50Gi"
`,
  },

  // ── Networking ─────────────────────────────────────────────────────────────

  {
    name:     'service',
    category: 'networking',
    description: 'ClusterIP Service — internal cluster access only. Use service-lb for external access via MetalLB, or pair with an Ingress.',
    yaml: `\
apiVersion: v1
kind: Service
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
spec:
  selector:
    app: {{ APP_NAME }}
  ports:
    - name: http
      port: {{ SERVICE_PORT }}       # port clients connect to (e.g. 80, 8080)
      targetPort: {{ PORT }}         # container port (must match Deployment containerPort)
  type: ClusterIP
`,
  },

  {
    name:     'service-lb',
    category: 'networking',
    description: 'LoadBalancer Service that gets a dedicated IP from MetalLB. Use for non-HTTP services (game servers, databases, VPNs). Do NOT set loadBalancerClass — it is immutable and breaks IP assignment.',
    yaml: `\
apiVersion: v1
kind: Service
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  annotations:
    metallb.universe.tf/address-pool: default   # use "default" unless you need a specific pool
spec:
  selector:
    app: {{ APP_NAME }}
  ports:
    - name: {{ PROTOCOL }}          # e.g. "tcp", "udp", "grpc"
      port: {{ SERVICE_PORT }}
      targetPort: {{ PORT }}
      protocol: TCP                 # change to UDP if needed
  type: LoadBalancer
  # DO NOT add loadBalancerClass — it is immutable once set and breaks MetalLB IP assignment
`,
  },

  {
    name:     'ingress-internal',
    category: 'networking',
    description: 'Traefik Ingress for internal services on *.khalis.corp. CrowdSec only — no Authentik SSO. TLS via cert-manager Let\'s Encrypt.',
    yaml: `\
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.middlewares: security-crowdsec-bouncer@kubernetescrd
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  tls:
    - hosts: [{{ HOSTNAME }}.khalis.corp]
      secretName: {{ APP_NAME }}-tls
  rules:
    - host: {{ HOSTNAME }}.khalis.corp
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ APP_NAME }}
                port: { number: {{ SERVICE_PORT }} }
`,
  },

  {
    name:     'ingress-public',
    category: 'networking',
    description: 'Traefik Ingress for public services on *.khalisio.com. Authentik SSO + CrowdSec. Do NOT apply to Authentik\'s own ingress — causes infinite redirect loop.',
    yaml: `\
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    # Both middlewares required for all public services:
    traefik.ingress.kubernetes.io/router.middlewares: >-
      security-authentik-forward-auth@kubernetescrd,security-crowdsec-bouncer@kubernetescrd
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  tls:
    - hosts: [{{ HOSTNAME }}.khalisio.com]
      secretName: {{ APP_NAME }}-tls
  rules:
    - host: {{ HOSTNAME }}.khalisio.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ APP_NAME }}
                port: { number: {{ SERVICE_PORT }} }
`,
  },

  // ── Storage ────────────────────────────────────────────────────────────────

  {
    name:     'pvc',
    category: 'storage',
    description: 'PersistentVolumeClaim backed by Longhorn (the cluster default). Longhorn replicates data across nodes — do not use hostPath for anything that needs durability.',
    yaml: `\
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ APP_NAME }}-data
  namespace: {{ NAMESPACE }}
spec:
  accessModes: [ReadWriteOnce]     # use ReadWriteMany only if multiple pods need simultaneous access
  storageClassName: longhorn
  resources:
    requests:
      storage: {{ STORAGE_SIZE }}  # e.g. "5Gi", "20Gi", "100Gi"
`,
  },

  // ── Secrets ────────────────────────────────────────────────────────────────

  {
    name:     'externalsecret',
    category: 'secrets',
    description: 'ExternalSecret that pulls credentials from Vault KV v2 and creates a Kubernetes Secret. All secrets must go through Vault — never hardcode values in manifests.',
    yaml: `\
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {{ APP_NAME }}-secret
  namespace: {{ NAMESPACE }}
spec:
  refreshInterval: 1h              # how often ESO re-syncs from Vault
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: {{ APP_NAME }}-secret    # name of the K8s Secret to create
    creationPolicy: Owner
  data:
    # Add one entry per key. vaultPath format: path/to/secret (no "secret/data/" prefix)
    - secretKey: {{ SECRET_KEY }}          # key name in the resulting K8s Secret
      remoteRef:
        key: secret/data/{{ VAULT_PATH }}  # Vault KV v2 path (e.g. "tailscale/oauth")
        property: {{ VAULT_PROPERTY }}     # field within that Vault secret

    # Example — multiple keys from the same Vault path:
    # - secretKey: CLIENT_ID
    #   remoteRef: { key: secret/data/myapp/oauth, property: clientId }
    # - secretKey: CLIENT_SECRET
    #   remoteRef: { key: secret/data/myapp/oauth, property: clientSecret }
`,
  },

  // ── GitOps ─────────────────────────────────────────────────────────────────

  {
    name:     'argocd-helm-app',
    category: 'gitops',
    description: 'ArgoCD Application that deploys a Helm chart from a public or OCI registry. ArgoCD handles upgrades and drift detection — prefer this over kubectl apply for Helm charts.',
    yaml: `\
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {{ APP_NAME }}
  namespace: argocd               # always argocd — this is where ArgoCD watches
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    # For standard Helm repos:
    repoURL: {{ HELM_REPO_URL }}  # e.g. "https://charts.bitnami.com/bitnami"
    chart: {{ HELM_CHART }}       # e.g. "postgresql"
    targetRevision: {{ VERSION }} # e.g. "13.2.1" — pin to a version, never "latest"

    # For OCI Helm charts (e.g. Tailscale operator), use instead:
    # repoURL: oci://ghcr.io/{{ ORG }}
    # chart: {{ HELM_CHART }}
    # targetRevision: {{ VERSION }}

    helm:
      releaseName: {{ APP_NAME }}
      valueFiles: []               # add paths to values files in the source repo if needed
      values: |
        # Inline Helm values — override chart defaults here
        # Reference secrets created by ExternalSecret:
        # existingSecret: {{ APP_NAME }}-secret

  destination:
    server: https://kubernetes.default.svc
    namespace: {{ NAMESPACE }}

  syncPolicy:
    automated:
      prune: true                  # remove resources no longer in chart
      selfHeal: true               # revert manual kubectl changes
    syncOptions:
      - CreateNamespace=true
`,
  },

  {
    name:     'argocd-gitops-app',
    category: 'gitops',
    description: 'ArgoCD Application that syncs plain Kubernetes manifests from a Gitea repository directory. Use this when managing raw YAML rather than Helm charts.',
    yaml: `\
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {{ APP_NAME }}
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ GITEA_REPO_URL }}  # e.g. "https://gitea.khalis.corp/khalisio/k8s-manifests"
    targetRevision: main
    path: {{ MANIFEST_PATH }}      # directory within the repo, e.g. "deployments/tailscale"

  destination:
    server: https://kubernetes.default.svc
    namespace: {{ NAMESPACE }}

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
`,
  },

]

/** Lookup a template by name. Returns undefined if not found. */
export function getTemplate(name: string): DeploymentTemplate | undefined {
  return DEPLOYMENT_TEMPLATES.find(t => t.name === name)
}
