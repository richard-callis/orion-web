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
  const reqUrl = new URL(req.url)
  const mccUrl = `${reqUrl.protocol}//${reqUrl.host}`
  const envName = record.environment.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  const manifest = `---
# Mission Control Gateway — auto-generated manifest
# Environment: ${record.environment.name}
# Expires: ${record.expiresAt.toISOString()}
# Apply with: kubectl apply -f <(curl -s '${mccUrl}/api/environments/join/${params.token}/manifest')
apiVersion: v1
kind: Namespace
metadata:
  name: management

---
apiVersion: v1
kind: Secret
metadata:
  name: mcc-gateway-${envName}-join
  namespace: management
  annotations:
    mcc/environment-id: "${record.environmentId}"
    mcc/expires-at: "${record.expiresAt.toISOString()}"
stringData:
  join-token: "${params.token}"
  mcc-url: "${mccUrl}"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcc-gateway-${envName}
  namespace: management
  labels:
    app: mcc-gateway-${envName}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcc-gateway-${envName}
  template:
    metadata:
      labels:
        app: mcc-gateway-${envName}
    spec:
      serviceAccountName: mcc-gateway
      nodeSelector:
        kubernetes.io/arch: amd64
      containers:
        - name: gateway
          image: mcc-gateway:latest
          imagePullPolicy: Never
          ports:
            - containerPort: 3001
          env:
            - name: PORT
              value: "3001"
            - name: GATEWAY_TYPE
              value: "${gatewayType}"
            - name: MCC_URL
              valueFrom:
                secretKeyRef:
                  name: mcc-gateway-${envName}-join
                  key: mcc-url
            - name: JOIN_TOKEN
              valueFrom:
                secretKeyRef:
                  name: mcc-gateway-${envName}-join
                  key: join-token
            - name: GATEWAY_URL
              value: "http://mcc-gateway-${envName}.management.svc.cluster.local:3001"
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
  name: mcc-gateway-${envName}
  namespace: management
spec:
  selector:
    app: mcc-gateway-${envName}
  ports:
    - port: 3001
      targetPort: 3001
`

  return new NextResponse(manifest, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
