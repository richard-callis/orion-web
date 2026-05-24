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
#
# We copy the docker binary from the official docker:cli image rather than
# fetching a pinned tar URL, which avoids 404s as old versions are removed
# from the download server.
FROM docker:27-cli AS docker-cli

FROM timberio/vector:0.39.0-debian
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
USER vector
