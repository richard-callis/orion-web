# MinIO client (mc), built from source.
#
# Used by the minio-init compose service to create the audit-log bucket.
# Matches the mc release existing hosts already run. Bump MC_RELEASE and
# MC_COMMIT together — the build fails if the tag does not resolve to the
# expected commit.
#
# Build: docker build -f deploy/minio/Dockerfile.mc deploy/minio

ARG GO_IMAGE=golang:1.24.6-alpine3.22@sha256:c8c5f95d64aa79b6547f3b626eb84b16a7ce18a139e3e9ca19a8c078b85ba80d
ARG RUNTIME_IMAGE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${GO_IMAGE} AS build
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 --branch "${MC_RELEASE}" https://github.com/minio/mc.git . \
 && test "$(git rev-parse HEAD)" = "${MC_COMMIT}" \
 || (echo "mc tag ${MC_RELEASE} does not resolve to ${MC_COMMIT}" >&2; exit 1)
RUN RELTIME="$(echo "${MC_RELEASE#RELEASE.}" | sed -E 's/T([0-9]+)-([0-9]+)-([0-9]+)Z$/T\1:\2:\3Z/')" \
 && LDFLAGS="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${RELTIME}")" \
 && CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} GOTOOLCHAIN=local \
    go build -trimpath -ldflags "${LDFLAGS}" -o /out/mc \
 && /out/mc --version

FROM ${RUNTIME_IMAGE}
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
LABEL org.opencontainers.image.title="mc" \
      org.opencontainers.image.version="${MC_RELEASE}" \
      org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
RUN apk add --no-cache ca-certificates \
 && addgroup -S -g 1000 mc \
 && adduser -S -D -h /home/mc -u 1000 -G mc mc
COPY --from=build /out/mc /usr/bin/mc
ENV MC_CONFIG_DIR=/tmp/.mc
USER mc
ENTRYPOINT ["/usr/bin/mc"]
