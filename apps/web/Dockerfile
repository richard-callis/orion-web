# syntax=docker/dockerfile:1
# Build context: REPOSITORY ROOT (docker build -f apps/web/Dockerfile .)
# so the single workspace lockfile (package-lock.json at the root) is enforced
# with `npm ci`. Multi-arch: linux/amd64 + linux/arm64 (TARGETARCH from buildx).
#
# Base image is pinned by version AND digest (multi-arch index digest), and
# every downloaded binary is pinned and sha256-verified, so builds are
# reproducible. Dependabot (docker ecosystem) proposes version/digest bumps.

# ── Dependencies (lockfile-enforced) ─────────────────────────────────────────
FROM node:26.10.0-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS deps
WORKDIR /app
# OpenSSL for Prisma; toolchain for any native module builds
RUN apk add --no-cache openssl make g++
COPY package.json package-lock.json ./
# npm ci validates every workspace listed in the lockfile, so all workspace
# manifests must be present; only apps/web's dependencies get installed.
COPY apps/web/package.json apps/web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/executor/package.json apps/executor/package.json
# npm ci fails if the lockfile is out of sync with package.json. The runtime
# image needs the prisma CLI (a devDependency) for migrations, so dev
# dependencies are kept rather than pruned.
RUN npm ci --workspace apps/web --include-workspace-root=false --legacy-peer-deps

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY apps/web apps/web
WORKDIR /app/apps/web
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── CLI tools (pinned + checksum-verified) ───────────────────────────────────
FROM node:26.10.0-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS tools
ARG TARGETARCH
ARG KUBECTL_VERSION=1.33.1
ARG HELM_VERSION=4.2.0
ARG TALOSCTL_VERSION=1.13.2
RUN apk add --no-cache curl \
 && ARCH=${TARGETARCH:-amd64} \
 && case "$ARCH" in \
      amd64) KUBECTL_SHA=5de4e9f2266738fd112b721265a0c1cd7f4e5208b670f811861f699474a100a3; \
             HELM_SHA=97dbeb971be4ac4b27e3839976d9564c0fb35c6f3b1da89dd1e292d236af4096; \
             TALOSCTL_SHA=86e21c434300ab71c27e8644570b14463c8ce78fc272853691de906af8d1c1bb ;; \
      arm64) KUBECTL_SHA=d595d1a26b7444e0beb122e25750ee4524e74414bbde070b672b423139295ce6; \
             HELM_SHA=1f8de130dfbd04de64978e7b852a7a547be1404956a366608276d2520b678670; \
             TALOSCTL_SHA=dcf55741d8fff5793bac0ea9bbcea3147645c1eee6942eb6562db6c2235aac5c ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && mkdir -p /out && cd /tmp \
 && curl -fsSLo kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
 && echo "${KUBECTL_SHA}  kubectl" | sha256sum -c - \
 && curl -fsSLo helm.tgz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${ARCH}.tar.gz" \
 && echo "${HELM_SHA}  helm.tgz" | sha256sum -c - \
 && tar -xzf helm.tgz --strip-components=1 "linux-${ARCH}/helm" \
 && curl -fsSLo talosctl "https://github.com/siderolabs/talos/releases/download/v${TALOSCTL_VERSION}/talosctl-linux-${ARCH}" \
 && echo "${TALOSCTL_SHA}  talosctl" | sha256sum -c - \
 && install -m 0755 kubectl helm talosctl /out/

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:26.10.0-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# OpenSSL (Prisma), bash, curl (healthcheck), git, openssh-client
RUN apk add --no-cache openssl libc6-compat bash curl git openssh-client

# Create non-root user for security (SOC2)
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# SSH config: auto-accept new host keys for homelab use
RUN mkdir -p /home/nextjs/.ssh && chmod 700 /home/nextjs/.ssh \
 && printf 'Host *\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile /home/nextjs/.ssh/known_hosts\n' > /home/nextjs/.ssh/config \
 && chmod 600 /home/nextjs/.ssh/config \
 && chown -R nextjs:nodejs /home/nextjs/.ssh

COPY --from=tools /out/ /usr/local/bin/

ENV SHELL=/bin/bash

# Standalone output. In a workspace build Next nests the app under
# .next/standalone/apps/web; flatten it so server.js lives at /app.
COPY --from=builder /app/apps/web/.next/standalone/apps/web ./
COPY --from=builder /app/apps/web/.next/static ./.next/static
COPY --from=builder /app/apps/web/prisma ./prisma
# Prisma 7: migrate reads the datasource URL from prisma.config.mjs.
COPY --from=builder /app/apps/web/prisma.config.mjs ./prisma.config.mjs

# All node_modules from the (hoisted) workspace install: production deps plus
# the prisma CLI used by entrypoint.sh and the generated Prisma client.
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/apps/web/worker.js ./worker.js
COPY apps/web/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

USER nextjs
CMD ["sh", "entrypoint.sh"]
