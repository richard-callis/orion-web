/**
 * Deployment template registry.
 *
 * Generic Kubernetes building blocks agents use as starting points for any
 * cluster. Templates contain only standard Kubernetes primitives and clearly
 * marked {{ PLACEHOLDER }} fields — no assumptions about ingress controller,
 * storage class, secret manager, or cloud provider.
 *
 * Agents fill in the placeholders for their target environment, remove
 * optional sections they don't need, then propose the result to the GitOps
 * repo via gitops_propose.
 *
 * During bootstrap, all templates are pushed to the configured Git repo so
 * they live alongside cluster manifests from day one.
 *
 * Placeholder convention:
 *   {{ PLACEHOLDER }}   — required, must be replaced before applying
 *   {{ PLACEHOLDER? }}  — optional, remove the whole line if not needed
 */

export interface DeploymentTemplate {
  name:        string
  category:    'core' | 'workload' | 'networking' | 'storage' | 'secrets' | 'gitops' | 'docker'
  description: string
  yaml:        string
}

export const DEPLOYMENT_TEMPLATES: DeploymentTemplate[] = [

  // ── Core ───────────────────────────────────────────────────────────────────

  {
    name:     'namespace',
    category: 'core',
    description: 'Kubernetes Namespace. Always the first resource to create for a new service.',
    yaml: `\
apiVersion: v1
kind: Namespace
metadata:
  name: {{ NAMESPACE }}            # e.g. "monitoring", "apps", "my-service"
  labels:
    app.kubernetes.io/name: {{ APP_NAME }}
    app.kubernetes.io/managed-by: orion
`,
  },

  // ── Workloads ──────────────────────────────────────────────────────────────

  {
    name:     'deployment',
    category: 'workload',
    description: 'Standard Deployment for stateless services. Includes resource limits and optional health checks.',
    yaml: `\
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  labels:
    app: {{ APP_NAME }}
spec:
  replicas: 1                      # increase for HA; consider HPA for autoscaling
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
          image: {{ IMAGE }}        # e.g. "nginx:1.25.3" — pin to a specific version/digest
          ports:
            - containerPort: {{ PORT }}

          # Environment variables — prefer secretRef over plain env for sensitive values:
          env: []
          # envFrom:
          #   - secretRef:
          #       name: {{ APP_NAME }}-secret

          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi

          # Health checks — uncomment and adjust paths/ports when the app supports them:
          # livenessProbe:
          #   httpGet: { path: /health, port: {{ PORT }} }
          #   initialDelaySeconds: 30
          #   periodSeconds: 10
          # readinessProbe:
          #   httpGet: { path: /ready, port: {{ PORT }} }
          #   initialDelaySeconds: 5
          #   periodSeconds: 5
`,
  },

  {
    name:     'statefulset',
    category: 'workload',
    description: 'StatefulSet for services that need stable network identity or persistent storage (databases, queues, stateful operators).',
    yaml: `\
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  labels:
    app: {{ APP_NAME }}
spec:
  serviceName: {{ APP_NAME }}      # must match the name of a headless Service for stable DNS
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
              mountPath: {{ MOUNT_PATH }}   # e.g. "/data", "/var/lib/postgresql"

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
        storageClassName: {{ STORAGE_CLASS }}   # use your cluster's default or a named class
        resources:
          requests:
            storage: {{ STORAGE_SIZE }}          # e.g. "10Gi", "50Gi"
`,
  },

  // ── Networking ─────────────────────────────────────────────────────────────

  {
    name:     'service',
    category: 'networking',
    description: 'ClusterIP Service — internal cluster access only. Pair with an Ingress for external HTTP/S access.',
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
      port: {{ SERVICE_PORT }}      # port clients connect to (e.g. 80, 8080)
      targetPort: {{ PORT }}        # container port (must match Deployment containerPort)
  type: ClusterIP
`,
  },

  {
    name:     'service-lb',
    category: 'networking',
    description: 'LoadBalancer Service for external access to non-HTTP services (game servers, databases, VPNs). The cloud provider or bare-metal load balancer assigns an external IP.',
    yaml: `\
apiVersion: v1
kind: Service
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  # Add provider-specific annotations here if required by your load balancer:
  # annotations:
  #   {{ ANNOTATION_KEY }}: {{ ANNOTATION_VALUE? }}
spec:
  selector:
    app: {{ APP_NAME }}
  ports:
    - name: {{ PROTOCOL }}          # e.g. "tcp", "udp", "grpc"
      port: {{ SERVICE_PORT }}
      targetPort: {{ PORT }}
      protocol: TCP                 # change to UDP if needed
  type: LoadBalancer
`,
  },

  {
    name:     'ingress',
    category: 'networking',
    description: 'Standard Kubernetes Ingress for HTTP/S routing. Fill in the ingress class for your controller (nginx, traefik, istio, etc.) and add any controller-specific annotations.',
    yaml: `\
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ APP_NAME }}
  namespace: {{ NAMESPACE }}
  annotations:
    # Add controller-specific annotations here, for example:
    # nginx.ingress.kubernetes.io/rewrite-target: /
    # traefik.ingress.kubernetes.io/router.middlewares: {{ MIDDLEWARE? }}
    # cert-manager.io/cluster-issuer: {{ CERT_ISSUER? }}
spec:
  ingressClassName: {{ INGRESS_CLASS }}   # e.g. "nginx", "traefik", "istio"
  # TLS — remove this section if not using HTTPS:
  tls:
    - hosts: [{{ HOSTNAME }}]
      secretName: {{ APP_NAME }}-tls
  rules:
    - host: {{ HOSTNAME }}               # e.g. "myapp.example.com"
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
    description: 'PersistentVolumeClaim for durable storage. Set the storageClassName to match your cluster\'s provisioner (e.g. standard, gp2, longhorn).',
    yaml: `\
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ APP_NAME }}-data
  namespace: {{ NAMESPACE }}
spec:
  accessModes: [ReadWriteOnce]        # use ReadWriteMany only if multiple pods need simultaneous access
  storageClassName: {{ STORAGE_CLASS }}  # your cluster's storage provisioner
  resources:
    requests:
      storage: {{ STORAGE_SIZE }}     # e.g. "5Gi", "20Gi", "100Gi"
`,
  },

  // ── Secrets ────────────────────────────────────────────────────────────────

  {
    name:     'externalsecret',
    category: 'secrets',
    description: 'ExternalSecret (external-secrets.io) that pulls credentials from a secret store and creates a Kubernetes Secret. Requires the External Secrets Operator to be installed.',
    yaml: `\
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {{ APP_NAME }}-secret
  namespace: {{ NAMESPACE }}
spec:
  refreshInterval: 1h                  # how often to re-sync from the secret store
  secretStoreRef:
    name: {{ SECRET_STORE_NAME }}      # name of the SecretStore or ClusterSecretStore
    kind: ClusterSecretStore           # use SecretStore for namespace-scoped stores
  target:
    name: {{ APP_NAME }}-secret        # name of the Kubernetes Secret to create
    creationPolicy: Owner
  data:
    # One entry per key — agents should add one block per secret value needed:
    - secretKey: {{ SECRET_KEY }}          # key in the resulting K8s Secret
      remoteRef:
        key: {{ REMOTE_KEY }}             # path/key in the external store
        property: {{ REMOTE_PROPERTY? }}  # field within the remote key (if the store uses nested values)
`,
  },

  // ── GitOps ─────────────────────────────────────────────────────────────────

  {
    name:     'argocd-helm-app',
    category: 'gitops',
    description: 'ArgoCD Application that deploys a Helm chart. ArgoCD handles upgrades and drift detection. Requires ArgoCD to be installed.',
    yaml: `\
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {{ APP_NAME }}
  namespace: argocd                   # always "argocd" — where ArgoCD watches
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ HELM_REPO_URL }}      # e.g. "https://charts.bitnami.com/bitnami"
    chart: {{ HELM_CHART }}           # chart name within the repo
    targetRevision: {{ VERSION }}     # pin to a specific version, e.g. "13.2.1"

    # For OCI Helm charts substitute repoURL with the OCI registry:
    # repoURL: oci://{{ OCI_REGISTRY }}   # e.g. "oci://ghcr.io/org"
    # chart: {{ HELM_CHART }}
    # targetRevision: {{ VERSION }}

    helm:
      releaseName: {{ APP_NAME }}
      values: |
        # Inline Helm values — override chart defaults here
        # {{ VALUE_KEY }}: {{ VALUE? }}

  destination:
    server: https://kubernetes.default.svc
    namespace: {{ NAMESPACE }}

  syncPolicy:
    automated:
      prune: true          # remove resources no longer in the chart
      selfHeal: true       # revert manual kubectl changes
    syncOptions:
      - CreateNamespace=true
`,
  },

  {
    name:     'argocd-gitops-app',
    category: 'gitops',
    description: 'ArgoCD Application that syncs plain Kubernetes manifests from a Git repository directory. Use when managing raw YAML rather than Helm charts.',
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
    repoURL: {{ REPO_URL }}           # e.g. "https://github.com/org/k8s-manifests"
    targetRevision: main
    path: {{ MANIFEST_PATH }}         # directory in the repo, e.g. "deployments/myapp"

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

  // ── Docker ─────────────────────────────────────────────────────────────────

  {
    name:     'docker-compose-service',
    category: 'docker',
    description: 'Minimal Docker Compose service. Use for stateless apps that need no persistent storage. Extend with volumes, networks, or labels as needed.',
    yaml: `\
services:
  {{ APP_NAME }}:
    image: {{ IMAGE }}              # e.g. "nginx:1.25.3" — pin to a specific version/digest
    container_name: {{ APP_NAME }}
    restart: unless-stopped

    ports:
      - "{{ HOST_PORT }}:{{ CONTAINER_PORT }}"   # remove if not exposing directly; use a proxy instead

    environment:
      # Prefer secrets (see docker-compose-secrets template) over plain env vars for sensitive values:
      # KEY: value

    # Resource limits — remove if your Docker engine does not enforce them:
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 512M
        reservations:
          cpus: "0.1"
          memory: 128M
`,
  },

  {
    name:     'docker-compose-with-volumes',
    category: 'docker',
    description: 'Docker Compose service with named volumes for persistent storage. Use for databases, file stores, or any stateful container.',
    yaml: `\
services:
  {{ APP_NAME }}:
    image: {{ IMAGE }}
    container_name: {{ APP_NAME }}
    restart: unless-stopped

    ports:
      - "{{ HOST_PORT }}:{{ CONTAINER_PORT }}"

    environment: {}

    volumes:
      - {{ APP_NAME }}-data:{{ MOUNT_PATH }}   # e.g. /var/lib/postgresql/data, /data

    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 1G
        reservations:
          cpus: "0.25"
          memory: 256M

volumes:
  {{ APP_NAME }}-data:
    driver: local
    # To use a bind-mount instead, replace the above with:
    # driver_opts:
    #   type: none
    #   o: bind
    #   device: {{ HOST_DATA_PATH? }}   # absolute path on the host, e.g. /srv/{{ APP_NAME }}
`,
  },

  {
    name:     'docker-compose-proxy',
    category: 'docker',
    description: 'Docker Compose service configured for use behind a reverse proxy (Traefik, Caddy, nginx, etc.). Exposes no host ports — traffic flows through the proxy network.',
    yaml: `\
services:
  {{ APP_NAME }}:
    image: {{ IMAGE }}
    container_name: {{ APP_NAME }}
    restart: unless-stopped

    # No host port mapping — the proxy handles external traffic.
    expose:
      - "{{ CONTAINER_PORT }}"

    environment: {}

    networks:
      - proxy      # shared network the reverse proxy is attached to
      # - internal # add additional internal-only networks as needed

    # Traefik label example — remove or swap for your proxy's annotation style:
    # labels:
    #   traefik.enable: "true"
    #   traefik.http.routers.{{ APP_NAME }}.rule: "Host(\`{{ HOSTNAME }}\`)"
    #   traefik.http.routers.{{ APP_NAME }}.entrypoints: "websecure"
    #   traefik.http.routers.{{ APP_NAME }}.tls.certresolver: "{{ CERT_RESOLVER? }}"
    #   traefik.http.services.{{ APP_NAME }}.loadbalancer.server.port: "{{ CONTAINER_PORT }}"

    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 512M

networks:
  proxy:
    external: true   # must already exist: docker network create proxy
`,
  },

  {
    name:     'docker-compose-secrets',
    category: 'docker',
    description: 'Docker Compose service that consumes secrets from files (Docker Swarm secrets or bind-mounted secret files). Keeps sensitive values out of environment variables and image layers.',
    yaml: `\
services:
  {{ APP_NAME }}:
    image: {{ IMAGE }}
    container_name: {{ APP_NAME }}
    restart: unless-stopped

    ports:
      - "{{ HOST_PORT }}:{{ CONTAINER_PORT }}"

    # Secrets are mounted read-only at /run/secrets/<secret-name> inside the container.
    # The app must read them from the filesystem rather than env vars.
    secrets:
      - {{ SECRET_NAME }}         # e.g. db_password, api_key

    environment:
      # Point the app at the secret file path when it supports a _FILE convention:
      # {{ ENV_VAR }}_FILE: /run/secrets/{{ SECRET_NAME }}

secrets:
  {{ SECRET_NAME }}:
    # Option A — external Docker Swarm secret (swarm mode only):
    # external: true

    # Option B — bind-mount a file from the host (compose standalone):
    file: {{ SECRET_FILE_PATH }}   # e.g. ./secrets/db_password.txt — never commit this file
`,
  },

]

/** Lookup a template by name. Returns undefined if not found. */
export function getTemplate(name: string): DeploymentTemplate | undefined {
  return DEPLOYMENT_TEMPLATES.find(t => t.name === name)
}
