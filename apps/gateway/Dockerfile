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

RUN apk add --no-cache curl docker-cli bash

# Install kubectl — architecture-aware (default amd64 for plain docker build)
RUN ARCH=${TARGETARCH:-amd64} \
    && KUBECTL_VERSION=$(curl -fsSL https://dl.k8s.io/release/stable.txt) \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
         -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# Install talosctl — architecture-aware (version pinned)
ARG TALOSCTL_VERSION=1.13.2
RUN ARCH=${TARGETARCH:-amd64} \
    && curl -fsSL "https://github.com/siderolabs/talos/releases/download/v${TALOSCTL_VERSION}/talosctl-linux-${ARCH}" \
         -o /usr/local/bin/talosctl \
    && chmod +x /usr/local/bin/talosctl

# Install helm — architecture-aware (version pinned)
ARG HELM_VERSION=4.2.0
RUN ARCH=${TARGETARCH:-amd64} \
    && curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${ARCH}.tar.gz" \
         | tar -xz --strip-components=1 -C /usr/local/bin "linux-${ARCH}/helm" \
    && chmod +x /usr/local/bin/helm

COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps
COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/index.js"]
