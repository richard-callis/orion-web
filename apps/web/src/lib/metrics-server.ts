/**
 * metrics-server lifecycle for cluster environments.
 *
 * Node CPU/memory on the Infrastructure page comes from metrics.k8s.io, which
 * only exists when metrics-server is installed. ORION installs it through the
 * environment's gateway — after a gateway joins, or on demand from the UI —
 * unless the cluster already runs one ORION doesn't manage (k3s, managed
 * clouds, a GitOps-installed copy), which is left alone.
 */
import type { Environment } from '@prisma/client'
import { GatewayClient } from '@/lib/agent-runner/gateway-client'
import { makeLocalGx } from '@/lib/local-exec'

export const METRICS_SERVER_VERSION = 'v0.8.0'
const MANAGED_BY = 'app.kubernetes.io/managed-by'
const APISERVICE = 'v1beta1.metrics.k8s.io'

/**
 * Permissions the gateway needs to install metrics-server and read metrics.
 * RBAC escalation prevention means the gateway can only create the
 * metrics-server roles/bindings if it already holds every permission they
 * grant — hence nodes/metrics, tokenreviews and subjectaccessreviews.
 * Shipped in the join manifest; re-applied here when the caller can.
 */
export const GATEWAY_METRICS_RBAC = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: orion-gateway-metrics
  labels:
    ${MANAGED_BY}: orion
rules:
  # Read-only: the gateway reads metrics and checks whether metrics-server is
  # installed. It no longer installs it (that needs RBAC-granting rights, which
  # make the gateway admin-equivalent); metrics-server ships in the join
  # manifest, applied with the installer's admin credentials.
  - apiGroups: ["metrics.k8s.io"]
    resources: ["nodes", "pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apiregistration.k8s.io"]
    resources: ["apiservices"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["nodes/metrics"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: orion-gateway-metrics
  labels:
    ${MANAGED_BY}: orion
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: orion-gateway-metrics
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: management
`

/**
 * Upstream metrics-server components.yaml (${METRICS_SERVER_VERSION}), labelled as
 * ORION-managed. Talos and other distros with self-signed kubelet serving
 * certs need --kubelet-insecure-tls; turn it off per environment
 * (metadata.metricsServer.kubeletInsecureTls = false) once kubelet certs are
 * signed by the cluster CA.
 */
export function metricsServerManifest({ kubeletInsecureTls }: { kubeletInsecureTls: boolean }): string {
  const labels = `k8s-app: metrics-server\n    ${MANAGED_BY}: orion`
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: metrics-server
  namespace: kube-system
  labels:
    ${labels}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: system:aggregated-metrics-reader
  labels:
    ${labels}
    rbac.authorization.k8s.io/aggregate-to-admin: "true"
    rbac.authorization.k8s.io/aggregate-to-edit: "true"
    rbac.authorization.k8s.io/aggregate-to-view: "true"
rules:
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods", "nodes"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: system:metrics-server
  labels:
    ${labels}
rules:
  - apiGroups: [""]
    resources: ["nodes/metrics"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods", "nodes"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: metrics-server-auth-reader
  namespace: kube-system
  labels:
    ${labels}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: extension-apiserver-authentication-reader
subjects:
  - kind: ServiceAccount
    name: metrics-server
    namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: metrics-server:system:auth-delegator
  labels:
    ${labels}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:auth-delegator
subjects:
  - kind: ServiceAccount
    name: metrics-server
    namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system:metrics-server
  labels:
    ${labels}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:metrics-server
subjects:
  - kind: ServiceAccount
    name: metrics-server
    namespace: kube-system
---
apiVersion: v1
kind: Service
metadata:
  name: metrics-server
  namespace: kube-system
  labels:
    ${labels}
spec:
  ports:
    - name: https
      port: 443
      protocol: TCP
      targetPort: https
  selector:
    k8s-app: metrics-server
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: metrics-server
  namespace: kube-system
  labels:
    ${labels}
spec:
  selector:
    matchLabels:
      k8s-app: metrics-server
  strategy:
    rollingUpdate:
      maxUnavailable: 0
  template:
    metadata:
      labels:
        k8s-app: metrics-server
    spec:
      containers:
        - name: metrics-server
          image: registry.k8s.io/metrics-server/metrics-server:${METRICS_SERVER_VERSION}
          imagePullPolicy: IfNotPresent
          args:
            - --cert-dir=/tmp
            - --secure-port=10250
            - --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
            - --kubelet-use-node-status-port
            - --metric-resolution=15s${kubeletInsecureTls ? '\n            - --kubelet-insecure-tls' : ''}
          ports:
            - containerPort: 10250
              name: https
              protocol: TCP
          livenessProbe:
            failureThreshold: 3
            httpGet:
              path: /livez
              port: https
              scheme: HTTPS
            periodSeconds: 10
          readinessProbe:
            failureThreshold: 3
            httpGet:
              path: /readyz
              port: https
              scheme: HTTPS
            initialDelaySeconds: 20
            periodSeconds: 10
          resources:
            requests:
              cpu: 100m
              memory: 200Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            seccompProfile:
              type: RuntimeDefault
          volumeMounts:
            - mountPath: /tmp
              name: tmp-dir
      nodeSelector:
        kubernetes.io/os: linux
      priorityClassName: system-cluster-critical
      serviceAccountName: metrics-server
      volumes:
        - emptyDir: {}
          name: tmp-dir
---
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: ${APISERVICE}
  labels:
    ${labels}
spec:
  group: metrics.k8s.io
  groupPriorityMinimum: 100
  insecureSkipTLSVerify: true
  service:
    name: metrics-server
    namespace: kube-system
  version: v1beta1
  versionPriority: 100
`
}

export type MetricsServerResult =
  | { status: 'installed' | 'updated'; via: 'kubeconfig' }
  | { status: 'existing' }            // a metrics-server ORION doesn't manage is already present
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string }

type Exec = (tool: string, args: Record<string, unknown>) => Promise<string>

function kubeletInsecureTls(env: Pick<Environment, 'metadata'>): boolean {
  const meta = (env.metadata ?? {}) as { metricsServer?: { kubeletInsecureTls?: boolean } }
  return meta.metricsServer?.kubeletInsecureTls ?? true
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const ADMIN_STEP =
  "Generate a new join token (Deploy gateway → metrics-server only) and apply that manifest " +
  "(?only=metrics-server) once with the cluster's admin credentials."

/**
 * Install (or update an ORION-managed) metrics-server in a cluster environment.
 * Idempotent. The gateway is read-only, so it only checks what is installed;
 * the install itself needs admin credentials: the stored admin kubeconfig when
 * there is one, otherwise the owner re-applies the join manifest's
 * metrics-server part (?only=metrics-server) with admin credentials.
 */
export async function ensureMetricsServer(
  env: Pick<Environment, 'type' | 'gatewayUrl' | 'gatewayToken' | 'kubeconfig' | 'metadata'>,
): Promise<MetricsServerResult> {
  if (env.type !== 'cluster') return { status: 'skipped', reason: `not a Kubernetes environment (${env.type})` }
  if (!env.gatewayUrl || !env.gatewayToken) return { status: 'skipped', reason: 'gateway not connected' }

  const gc = new GatewayClient(env.gatewayUrl, env.gatewayToken)
  const gateway: Exec = (tool, args) => gc.executeTool(tool, args)
  // Created lazily — makeLocalGx writes the kubeconfig to a temp file
  let local: Exec | null = null
  const getLocal = (): Exec | null => (env.kubeconfig ? (local ??= makeLocalGx(env.kubeconfig)) : null)

  // Writes need admin credentials; the gateway is read-only.
  const apply = async (manifest: string): Promise<'kubeconfig'> => {
    const admin = getLocal()
    if (!admin) {
      throw new Error(
        'the gateway is read-only and no admin kubeconfig is stored for this environment. ' + ADMIN_STEP,
      )
    }
    await admin('kubectl_apply_manifest', { manifest })
    return 'kubeconfig'
  }

  // 2. Leave a metrics-server ORION doesn't manage alone.
  let existed = false
  try {
    // Prefer admin credentials for the check too: environments joined before
    // the gateway had apiservices read would otherwise just see Forbidden.
    const check = getLocal() ?? gateway
    const raw = await check('kubectl_get', { resource: 'apiservices.apiregistration.k8s.io', name: APISERVICE, output: 'json' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc: any = JSON.parse(raw)
    existed = true
    if (svc?.metadata?.labels?.[MANAGED_BY] !== 'orion') return { status: 'existing' }
  } catch (e) {
    // NotFound (kubectl error) means not installed; Forbidden means the gateway's
    // metrics RBAC predates apiservices read; anything else is a real error
    if (/forbidden/i.test(msg(e))) return { status: 'error', error: `The gateway may not read the metrics-server APIService. ${ADMIN_STEP}` }
    if (!/NotFound|not found/i.test(msg(e))) return { status: 'error', error: `Checking for metrics-server failed: ${msg(e)}` }
  }

  // 3. Install / update ORION's copy (metrics RBAC included, so the gateway can read).
  try {
    const via = await apply(`${GATEWAY_METRICS_RBAC}---\n${metricsServerManifest({ kubeletInsecureTls: kubeletInsecureTls(env) })}`)
    return { status: existed ? 'updated' : 'installed', via }
  } catch (e) {
    return { status: 'error', error: `Installing metrics-server failed: ${msg(e)}` }
  }
}
