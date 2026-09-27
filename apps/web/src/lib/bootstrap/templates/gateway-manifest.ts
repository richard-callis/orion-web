/**
 * In-cluster ORION Gateway manifests (namespace, RBAC, credentials Secret,
 * Deployment, Service). Pure function of its inputs — the ORION URL and image
 * spec are passed in rather than read from the environment here.
 */
import type { GatewayImageSpec } from '../../gateway-image'

export interface GatewayManifestInput {
  envName: string
  joinToken: string
  /** URL the gateway uses to reach ORION (stored in the credentials Secret). */
  orionUrl: string
  image: GatewayImageSpec
}

export function renderGatewayManifest({ envName, joinToken, orionUrl, image }: GatewayManifestInput): string {
  return `---
apiVersion: v1
kind: Namespace
metadata:
  name: orion-management
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orion-gateway
  namespace: orion-management
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: orion-gateway-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: orion-management
---
# Allows the gateway to write its registered credentials back to the Secret
# so they survive pod restarts without needing a PVC.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: orion-gateway-credentials
  namespace: orion-management
rules:
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["orion-gateway-credentials"]
  verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: orion-gateway-credentials
  namespace: orion-management
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: orion-gateway-credentials
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: orion-management
---
apiVersion: v1
kind: Secret
metadata:
  name: orion-gateway-credentials
  namespace: orion-management
stringData:
  join-token: "${joinToken}"
  orion-url: "${orionUrl}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orion-gateway
  namespace: orion-management
  labels:
    app: orion-gateway
spec:
  replicas: 1
  selector:
    matchLabels:
      app: orion-gateway
  template:
    metadata:
      labels:
        app: orion-gateway
    spec:
      serviceAccountName: orion-gateway
      containers:
        - name: gateway
          image: ${image.image}
          imagePullPolicy: ${image.pullPolicy}
          ports:
            - containerPort: 3001
          env:
            - name: PORT
              value: "3001"
            - name: GATEWAY_TYPE
              value: "cluster"
            - name: ENV_NAME
              value: "${envName}"
            - name: GATEWAY_NAMESPACE
              value: "orion-management"
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef: { fieldPath: metadata.namespace }
            - name: POD_NAME
              valueFrom:
                fieldRef: { fieldPath: metadata.name }
            - name: GATEWAY_DEPLOYMENT_NAME
              value: "orion-gateway"
            - name: ORION_URL
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-credentials
                  key: orion-url
            - name: JOIN_TOKEN
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-credentials
                  key: join-token
            # Credentials the gateway writes back after registering (the Role
            # above allows patching this Secret). Without GATEWAY_SECRET_NAME they
            # were never persisted, so a restarted pod re-joined with a spent token.
            - name: GATEWAY_SECRET_NAME
              value: "orion-gateway-credentials"
            - name: ENVIRONMENT_ID
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-credentials
                  key: environment-id
                  optional: true
            - name: GATEWAY_TOKEN
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-credentials
                  key: gateway-token
                  optional: true
            - name: MACHINE_ID
              valueFrom:
                secretKeyRef:
                  name: orion-gateway-credentials
                  key: machine-id
                  optional: true
            - name: GATEWAY_URL
              value: "http://orion-gateway.orion-management.svc.cluster.local:3001"
          # /health exists in every gateway image; /readyz (503 until the gateway
          # has registered and loaded its tool policy) only when the image is
          # pinned to a release that has it. See lib/gateway-image.ts.
          livenessProbe:
            httpGet: { path: ${image.livenessPath}, port: 3001 }
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet: { path: ${image.readinessPath}, port: 3001 }
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 256Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: orion-gateway
  namespace: orion-management
spec:
  selector:
    app: orion-gateway
  ports:
    - port: 3001
      targetPort: 3001
`
}
