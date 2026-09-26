# syntax=docker/dockerfile:1
# Build context: REPOSITORY ROOT (docker build -f apps/executor/Dockerfile .)
# so the single workspace lockfile is enforced with `npm ci`.
# Base image pinned by version + multi-arch index digest (same Node line as web/gateway).

# npm ci validates every workspace in the lockfile, so all manifests are copied;
# only apps/executor's dependencies are installed (all hoisted to /app/node_modules).
FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/executor/package.json apps/executor/package.json

FROM manifests AS builder
RUN npm ci --workspace apps/executor --include-workspace-root=false
COPY apps/executor/tsconfig.json apps/executor/tsconfig.json
COPY apps/executor/src apps/executor/src
RUN npm run build --workspace apps/executor

FROM manifests AS prod-deps
RUN npm ci --workspace apps/executor --include-workspace-root=false --omit=dev

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY apps/executor/package.json ./package.json
COPY --from=builder /app/apps/executor/dist ./dist
COPY apps/executor/config ./config

ENV NODE_ENV=production
ENV PORT=3200

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
USER nextjs
EXPOSE 3200

# node:alpine ships busybox wget but not curl
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3200/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
