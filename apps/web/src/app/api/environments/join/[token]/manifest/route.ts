/**
 * GET /api/environments/join/:token/manifest
 * Returns a ready-to-apply Kubernetes manifest with the join token pre-embedded.
 * The user pipes this directly to kubectl apply.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const record = await prisma.environmentJoinToken.findUnique({
    where: { token: params.token },
    include: { environment: true },
  })

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const gatewayType = searchParams.get('type') ?? record.environment.type ?? 'cluster'

  // ORION_CALLBACK_URL = the URL gateways use to reach ORION (LAN/internal, not behind Cloudflare).
  // Falls back to x-forwarded-host (Traefik), then MANAGEMENT_IP, then NEXTAUTH_URL.
  const forwardedHost = req.headers.get('x-forwarded-host')
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'http'
  const managementIp = process.env.MANAGEMENT_IP
  const orionUrl = (
    process.env.ORION_CALLBACK_URL ??
    (forwardedHost ? `${forwardedProto}://${forwardedHost}` : null) ??
    (managementIp ? `http://${managementIp}:3000` : null) ??
    process.env.NEXTAUTH_URL ??
    (() => { const u = new URL(req.url); return `${u.protocol}//${u.host}` })()
  ).replace(/\/$/, '')
  const envName = record.environment.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  // Use the environment's configured gatewayUrl if set; otherwise fall back to NodePort default.
  // For bare clusters (no ingress), the user sets gatewayUrl to http://<node-ip>:30001 when
  // creating the environment, and the NodePort service below exposes the gateway on that port.
  const gatewayUrl = record.environment.gatewayUrl ?? `http://<node-ip>:30001`

  const manifest = `---
# ORION Gateway — auto-generated manifest
# Environment: ${record.environment.name}
# Expires: ${record.expiresAt.toISOString()}
# Apply with: kubectl apply -f <(curl -s '${orionUrl}/api/environments/join/${params.token}/manifest')
apiVersion: v1
kind: Namespace
metadata:
  name: management

---
# ServiceAccount + RBAC — gateway needs read access to cluster resources
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orion-gateway
  namespace: management

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: orion-gateway
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec", "services", "endpoints", "configmaps", "namespaces", "nodes", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: orion-gateway
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: orion-gateway
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: management

---
# Scoped Role — lets the gateway patch its own join secret to persist permanent credentials
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: orion-gateway-secret-writer
  namespace: management
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "patch"]
    resourceNames: ["orion-gateway-${envName}-join"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: orion-gateway-secret-writer
  namespace: management
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: orion-gateway-secret-writer
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: management

---
apiVersion: v1
kind: Secret
metadata:
  name: orion-gateway-${envName}-join
  namespace: management
  annotations:
    orion/environment-id: "${record.environmentId}"
    orion/expires-at: "${record.expiresAt.toISOString()}"
stringData:
  join-token: "${params.token}"
  orion-url: "${orionUrl}"
  environment-id: ""
  gateway-token: ""

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orion-gateway-${envName}
  namespace: management
  labels:
    app: orion-gateway-${envName}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: orion-gateway-${envName}
  template:
    metadata:
      labels:
        app: orion-gateway-${envName}
    spec:
      serviceAccountName: orion-gateway
      containers:
        - name: gateway
          image: ghcr.io/richard-callis/orion-gateway:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 3001
          env:
            - name: PORT
              value: "3001"
            - name: GATEWAY_TYPE
              value: "${gatewayType}"
            - name: ORION_URL
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-${envName}-join
                  key: orion-url
            - name: JOIN_TOKEN
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-${envName}-join
                  key: join-token
            - name: GATEWAY_URL
              value: "${gatewayUrl}"
            - name: ENVIRONMENT_ID
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-${envName}-join
                  key: environment-id
                  optional: true
            - name: GATEWAY_TOKEN
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-${envName}-join
                  key: gateway-token
                  optional: true
            - name: GATEWAY_SECRET_NAME
              value: "orion-gateway-${envName}-join"
          livenessProbe:
            httpGet: { path: /health, port: 3001 }
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet: { path: /health, port: 3001 }
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 256Mi }

---
apiVersion: v1
kind: Service
metadata:
  name: orion-gateway-${envName}
  namespace: management
spec:
  type: NodePort
  selector:
    app: orion-gateway-${envName}
  ports:
    - port: 3001
      targetPort: 3001
      nodePort: 30001
`

  return new NextResponse(manifest, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
