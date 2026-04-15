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

RUN apk add --no-cache curl docker-cli bash

# Install kubectl — architecture-aware (default amd64 for plain docker build)
RUN ARCH=${TARGETARCH:-amd64} \
    && KUBECTL_VERSION=$(curl -fsSL https://dl.k8s.io/release/stable.txt) \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
         -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# Install helm — architecture-aware
RUN ARCH=${TARGETARCH:-amd64} \
    && HELM_VERSION=$(curl -fsSL https://api.github.com/repos/helm/helm/releases/latest | grep '"tag_name"' | sed 's/.*"tag_name": "\(.*\)".*/\1/') \
    && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz" \
         | tar -xz --strip-components=1 -C /usr/local/bin "linux-${ARCH}/helm" \
    && chmod +x /usr/local/bin/helm

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/index.js"]
