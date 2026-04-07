# syntax=docker/dockerfile:1
# Multi-arch: linux/amd64 + linux/arm64
ARG TARGETARCH

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
ARG TARGETARCH
WORKDIR /app

RUN apk add --no-cache curl docker-cli

# Install kubectl — architecture-aware
RUN curl -fsSL "https://dl.k8s.io/release/v1.33.0/bin/linux/${TARGETARCH}/kubectl" \
      -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/index.js"]
