# syntax=docker/dockerfile:1
# Multi-arch: linux/amd64 + linux/arm64
ARG TARGETARCH

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
ARG TARGETARCH
WORKDIR /app

ARG KUBECTL_VERSION=1.33.1
ARG TALOSCTL_VERSION=1.13.2
ARG HELM_VERSION=4.2.0

# Install all tools in one layer — pinned versions = stable cache hits
RUN apk add --no-cache curl docker-cli bash \
    && ARCH=${TARGETARCH:-amd64} \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
         -o /usr/local/bin/kubectl \
    && curl -fsSL "https://github.com/siderolabs/talos/releases/download/v${TALOSCTL_VERSION}/talosctl-linux-${ARCH}" \
         -o /usr/local/bin/talosctl \
    && curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${ARCH}.tar.gz" \
         | tar -xz --strip-components=1 -C /usr/local/bin "linux-${ARCH}/helm" \
    && chmod +x /usr/local/bin/kubectl /usr/local/bin/talosctl /usr/local/bin/helm

COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY --from=builder /app/dist ./dist

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
USER nextjs
EXPOSE 3001
CMD ["node", "dist/index.js"]
