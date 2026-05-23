# Custom Vector image for the ORION host-agent telemetry shipper.
#
# Why we don't use timberio/vector:0.39.0-debian directly:
# The `docker_lifecycle` source in vector.toml uses `type = "exec"` and runs
# `docker events --format ...` to stream container lifecycle events (oom, die,
# kill, restart, start) — Vector has no native source for these. The official
# image doesn't ship with the docker CLI, so the exec fails with ENOENT.
#
# This image adds *just the docker client* (not the daemon). The container
# uses the host's /var/run/docker.sock for daemon communication.
FROM timberio/vector:0.39.0-debian

USER root

ARG DOCKER_VERSION=26.1.5

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
        | tar -xz --strip-components=1 -C /usr/local/bin docker/docker && \
    chmod 755 /usr/local/bin/docker && \
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

USER vector
