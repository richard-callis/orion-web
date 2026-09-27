#!/usr/bin/env bash
# Build and boot the runtime containers CI otherwise never exercises.
#
# Each check exists because a green CI shipped a container that crashed in
# production (2026-09-27):
#   - gateway / executor images: missing app-local node_modules → ERR_MODULE_NOT_FOUND
#   - Vector 0.58: config rejected (env interpolation disabled)       → validate the real config
#   - Falco 0.45: missing container plugin                            → load the real config
#
# Usage: scripts/container-smoke.sh [gateway|executor|vector|falco ...]  (default: all)
# Needs only Docker. Uses throwaway names and no host ports.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="smoke-$$"
FAILED=0
cleanup() { docker rm -f "gw-$TAG" "ex-$TAG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

pass() { echo "✓ $*"; }
fail() { echo "::error::$*"; FAILED=1; }

# Poll a URL from inside the container (images ship wget via busybox/alpine).
wait_http() { # container url attempts
  local c=$1 url=$2 n=${3:-30}
  for _ in $(seq 1 "$n"); do
    if ! docker ps -q --filter "name=^$c$" | grep -q .; then return 2; fi
    docker exec "$c" wget -qO- "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

smoke_gateway() {
  echo "── gateway image"
  docker build -q -t "orion-gateway:$TAG" -f apps/gateway/Dockerfile . >/dev/null
  # No ORION reachable: the gateway must still listen first and serve /livez
  # while it retries registration in the background.
  docker run -d --name "gw-$TAG" \
    -e ORION_URL=http://127.0.0.1:9 -e GATEWAY_TOKEN=smoke -e ENVIRONMENT_ID=smoke \
    -e GATEWAY_TYPE=localhost "orion-gateway:$TAG" >/dev/null
  if wait_http "gw-$TAG" http://127.0.0.1:3001/livez 45; then pass "gateway boots and serves /livez"
  else fail "gateway did not serve /livez"; docker logs --tail 40 "gw-$TAG" 2>&1; fi
  docker rm -f "gw-$TAG" >/dev/null; docker rmi -f "orion-gateway:$TAG" >/dev/null
}

smoke_executor() {
  echo "── executor image"
  docker build -q -t "orion-executor:$TAG" -f apps/executor/Dockerfile . >/dev/null
  docker run -d --name "ex-$TAG" \
    -e ORION_URL=http://127.0.0.1:9 -e ORION_EXECUTOR_TOKEN=smoke "orion-executor:$TAG" >/dev/null
  if wait_http "ex-$TAG" http://127.0.0.1:3200/health 45; then pass "executor boots and serves /health"
  else fail "executor did not serve /health"; docker logs --tail 40 "ex-$TAG" 2>&1; fi
  docker rm -f "ex-$TAG" >/dev/null; docker rmi -f "orion-executor:$TAG" >/dev/null
}

smoke_vector() {
  echo "── host-agent Vector config"
  docker build -q -t "orion-vector:$TAG" -f deploy/host-agent/Dockerfile deploy/host-agent >/dev/null
  if docker run --rm -v "$PWD/deploy/host-agent/vector.toml:/etc/vector/vector.toml:ro" \
       -e HOST_AGENT_WEBHOOK_SECRET=smoke --entrypoint vector "orion-vector:$TAG" \
       validate --no-environment /etc/vector/vector.toml; then pass "vector.toml validates on the pinned image"
  else fail "vector.toml rejected by the pinned Vector image"; fi
  docker rmi -f "orion-vector:$TAG" >/dev/null
}

smoke_falco() {
  echo "── host-agent Falco config"
  local img
  img=$(grep -oE 'falcosecurity/falco:[0-9][^[:space:]"]*' deploy/docker-compose.yml | head -1)
  # --dry-run loads config, plugins and rules (incl. required_plugin_versions)
  # without opening a syscall source, so it needs no privileges.
  if docker run --rm \
       -v "$PWD/deploy/host-agent/falco/falco.yaml:/etc/falco/falco.yaml:ro" \
       -v "$PWD/deploy/host-agent/falco/falco_rules.local.yaml:/etc/falco/falco_rules.local.yaml:ro" \
       --entrypoint falco "$img" -c /etc/falco/falco.yaml --dry-run; then pass "falco.yaml + rules load on $img"
  else fail "Falco config/rules failed to load on $img"; fi
}

TARGETS=("$@"); [ ${#TARGETS[@]} -eq 0 ] && TARGETS=(gateway executor vector falco)
for t in "${TARGETS[@]}"; do "smoke_$t"; done
exit $FAILED
