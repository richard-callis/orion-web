# MinIO server, built from source.
#
# MinIO stopped publishing images (minio/minio on Docker Hub and Quay no longer
# exist), so ORION builds the server itself. The release matches the image that
# existing hosts already run (RELEASE.2025-09-07T16-13-09Z), so on-disk data and
# config stay compatible. Bump MINIO_RELEASE and MINIO_COMMIT together — the
# build fails if the tag does not resolve to the expected commit.
#
# Build: docker build -f deploy/minio/Dockerfile deploy/minio

ARG GO_IMAGE=golang:1.24.6-alpine3.22@sha256:c8c5f95d64aa79b6547f3b626eb84b16a7ce18a139e3e9ca19a8c078b85ba80d
ARG RUNTIME_IMAGE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${GO_IMAGE} AS build
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
ARG MINIO_COMMIT=07c3a429bfed433e49018cb0f78a52145d4bedeb
ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio.git . \
 && test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}" \
 || (echo "MinIO tag ${MINIO_RELEASE} does not resolve to ${MINIO_COMMIT}" >&2; exit 1)
# gen-ldflags wants the release time in RFC3339 form (2025-09-07T16:13:09Z).
RUN RELTIME="$(echo "${MINIO_RELEASE#RELEASE.}" | sed -E 's/T([0-9]+)-([0-9]+)-([0-9]+)Z$/T\1:\2:\3Z/')" \
 && LDFLAGS="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${RELTIME}")" \
 && CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} GOTOOLCHAIN=local \
    go build -tags kqueue -trimpath -ldflags "${LDFLAGS}" -o /out/minio \
 && /out/minio --version

FROM ${RUNTIME_IMAGE}
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
LABEL org.opencontainers.image.title="minio" \
      org.opencontainers.image.version="${MINIO_RELEASE}" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
RUN apk add --no-cache ca-certificates \
 && addgroup -S -g 1000 minio \
 && adduser -S -D -H -u 1000 -G minio minio \
 && mkdir -p /data && chown minio:minio /data
COPY --from=build /out/minio /usr/bin/minio
USER minio
VOLUME ["/data"]
EXPOSE 9000 9001
# busybox wget is in the base image; no curl needed.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q --spider http://127.0.0.1:9000/minio/health/live || exit 1
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
