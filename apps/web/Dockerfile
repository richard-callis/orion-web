# syntax=docker/dockerfile:1
# Multi-arch: linux/amd64 + linux/arm64
# TARGETARCH is injected by docker buildx (amd64 or arm64)
ARG TARGETARCH

FROM node:20-alpine AS deps
WORKDIR /app
# Build tools needed for node-pty native compilation
RUN apk add --no-cache make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --legacy-peer-deps

FROM node:20-alpine AS builder
WORKDIR /app
# Install OpenSSL (Prisma) + native build tools for node-pty
RUN apk add --no-cache openssl make g++
COPY --from=deps /app/node_modules ./node_modules
# Install devDependencies (esbuild, tsx, typescript) for the build step
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
ARG TARGETARCH
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install OpenSSL (Prisma), bash, curl, git, openssh-client, python3 (node-pty runtime)
RUN apk add --no-cache openssl libc6-compat bash curl git openssh-client

# SSH config: auto-accept new host keys for homelab use
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh \
 && printf 'Host *\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile /root/.ssh/known_hosts\n' > /root/.ssh/config \
 && chmod 600 /root/.ssh/config

# Install kubectl — architecture-aware, fetch stable version dynamically
RUN ARCH=${TARGETARCH:-amd64} \
    && KUBECTL_VERSION=$(curl -fsSL https://dl.k8s.io/release/stable.txt) \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
         -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# Install Helm — architecture-aware
RUN curl -fsSL "https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3" \
      | HELM_INSTALL_DIR=/usr/local/bin USE_SUDO=false bash

# Install talosctl — architecture-aware (for Talos cluster kubeconfig fetch)
RUN ARCH=${TARGETARCH:-amd64} \
    && TALOS_VERSION=$(curl -fsSL https://api.github.com/repos/siderolabs/talos/releases/latest | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": "\(.*\)".*/\1/') \
    && curl -fsSL "https://github.com/siderolabs/talos/releases/download/${TALOS_VERSION}/talosctl-linux-${ARCH}" \
         -o /usr/local/bin/talosctl \
    && chmod +x /usr/local/bin/talosctl

ENV SHELL=/bin/bash

# Standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma

# Copy all node_modules from builder (includes all production + transitive dependencies)
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/worker.js ./worker.js
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["sh", "entrypoint.sh"]
