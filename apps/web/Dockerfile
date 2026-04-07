# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM --platform=linux/amd64 node:20-alpine AS builder
WORKDIR /app
# Install OpenSSL so Prisma detects linux-musl-openssl-3.0.x and generates the correct binary
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
# Install devDependencies (esbuild, tsx, typescript) for the build step
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM --platform=linux/amd64 node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install OpenSSL (Prisma), bash (Claude Code SDK requires it), curl (kubectl download)
RUN apk add --no-cache openssl libc6-compat bash curl

# Install kubectl — needed for Claude's tool calls
RUN curl -fsSL "https://dl.k8s.io/release/v1.33.0/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

ENV SHELL=/bin/bash

# Non-root user
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Full prisma CLI (needed for migrate at startup)
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
# Claude Code SDK (dynamic import — not picked up by standalone bundler)
COPY --from=builder /app/node_modules/@anthropic-ai ./node_modules/@anthropic-ai

COPY --from=builder /app/worker.js ./worker.js
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

# Fix ownership so non-root user can write to prisma engine cache
RUN chown -R nextjs:nodejs /app/node_modules/@prisma /app/node_modules/.prisma /app/prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["sh", "entrypoint.sh"]
