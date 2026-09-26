# syntax=docker/dockerfile:1
# Build context: REPOSITORY ROOT (docker build -f apps/gateway/Dockerfile .)
# so the single workspace lockfile is enforced with `npm ci`.
# Multi-arch: linux/amd64 + linux/arm64 (TARGETARCH is injected by buildx).
#
# Base image pinned by version + multi-arch index digest; every downloaded
# binary is pinned and sha256-verified.
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# npm ci validates every workspace in the lockfile, so all manifests are copied;
# only apps/gateway's dependencies are installed (all hoisted to /app/node_modules).
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/executor/package.json apps/executor/package.json

FROM manifests AS builder
RUN npm ci --workspace apps/gateway --include-workspace-root=false --legacy-peer-deps
COPY apps/gateway/tsconfig.json apps/gateway/tsconfig.json
COPY apps/gateway/src apps/gateway/src
RUN npm run build --workspace apps/gateway

FROM manifests AS prod-deps
RUN npm ci --workspace apps/gateway --include-workspace-root=false --omit=dev --legacy-peer-deps

# ── CLI tools (pinned + checksum-verified) ───────────────────────────────────
FROM ${NODE_IMAGE} AS tools
ARG TARGETARCH
ARG KUBECTL_VERSION=1.33.1
ARG TALOSCTL_VERSION=1.13.2
ARG HELM_VERSION=4.2.0
ARG VELERO_VERSION=1.18.3
ARG TRIVY_VERSION=0.74.0
RUN apk add --no-cache curl \
 && ARCH=${TARGETARCH:-amd64} \
 && case "$ARCH" in \
      amd64) KUBECTL_SHA=5de4e9f2266738fd112b721265a0c1cd7f4e5208b670f811861f699474a100a3; \
             HELM_SHA=97dbeb971be4ac4b27e3839976d9564c0fb35c6f3b1da89dd1e292d236af4096; \
             TALOSCTL_SHA=86e21c434300ab71c27e8644570b14463c8ce78fc272853691de906af8d1c1bb; \
             VELERO_SHA=50012eda7424b0b94f53da563e2a48442d92a53c142c814b78e380a34139a98c; \
             TRIVY_ARCH=64bit; \
             TRIVY_SHA=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a ;; \
      arm64) KUBECTL_SHA=d595d1a26b7444e0beb122e25750ee4524e74414bbde070b672b423139295ce6; \
             HELM_SHA=1f8de130dfbd04de64978e7b852a7a547be1404956a366608276d2520b678670; \
             TALOSCTL_SHA=dcf55741d8fff5793bac0ea9bbcea3147645c1eee6942eb6562db6c2235aac5c; \
             VELERO_SHA=eadbfc8df33652f0c6c10112c9b486469b3dd38f2358869ea608411ab92e8c4a; \
             TRIVY_ARCH=ARM64; \
             TRIVY_SHA=b94ce1976bbf3c15b514b605ee88be7c6d94a29be2302847ff01cb794d47aad5 ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && mkdir -p /out && cd /tmp \
 && curl -fsSLo kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
 && echo "${KUBECTL_SHA}  kubectl" | sha256sum -c - \
 && curl -fsSLo talosctl "https://github.com/siderolabs/talos/releases/download/v${TALOSCTL_VERSION}/talosctl-linux-${ARCH}" \
 && echo "${TALOSCTL_SHA}  talosctl" | sha256sum -c - \
 && curl -fsSLo helm.tgz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${ARCH}.tar.gz" \
 && echo "${HELM_SHA}  helm.tgz" | sha256sum -c - \
 && tar -xzf helm.tgz --strip-components=1 "linux-${ARCH}/helm" \
 && curl -fsSLo velero.tgz "https://github.com/vmware-tanzu/velero/releases/download/v${VELERO_VERSION}/velero-v${VELERO_VERSION}-linux-${ARCH}.tar.gz" \
 && echo "${VELERO_SHA}  velero.tgz" | sha256sum -c - \
 && tar -xzf velero.tgz --strip-components=1 "velero-v${VELERO_VERSION}-linux-${ARCH}/velero" \
 && curl -fsSLo trivy.tgz "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${TRIVY_ARCH}.tar.gz" \
 && echo "${TRIVY_SHA}  trivy.tgz" | sha256sum -c - \
 && tar -xzf trivy.tgz trivy \
 && install -m 0755 kubectl talosctl helm velero trivy /out/

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
WORKDIR /app

# curl/bash are used by builtin tools; docker-cli for docker-type environments.
RUN apk add --no-cache curl docker-cli bash
COPY --from=tools /out/ /usr/local/bin/

COPY --from=prod-deps /app/node_modules ./node_modules
COPY apps/gateway/package.json ./package.json
COPY --from=builder /app/apps/gateway/dist ./dist

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
USER nextjs
EXPOSE 3001

# /livez is the liveness endpoint; /health is the legacy one (kept as a
# fallback so older gateway builds still report healthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/livez >/dev/null 2>&1 || wget -qO- http://127.0.0.1:3001/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
