#!/bin/bash
set -e

# Build ORION Docker image on homelab-master and distribute to all cluster nodes.
# Usage: ./build.sh [tag]
#
# Why this script does what it does:
#   - imagePullPolicy: Never means every node that might run the pod must have the image
#     locally in its containerd image store — there is no registry pull.
#   - K3s uses its OWN embedded containerd at /run/k3s/containerd/containerd.sock.
#     The system `ctr` command uses /run/containerd/containerd.sock (a different daemon).
#     Importing to the wrong socket means the image is invisible to k3s and pods fail
#     with ErrImageNeverPull even though `ctr images ls` shows the image.
#   - All amd64 nodes (CP + workers) must have the image because the scheduler can place
#     the pod on any of them.

TAG=${1:-$(git rev-parse --short HEAD 2>/dev/null || echo "dev")}
IMAGE="orion:$TAG"

# All amd64 nodes that can run the pod (RPi nodes are arm64 and won't be scheduled)
NODES=(
  "ubuntu@10.2.2.242"  # k3s-ubuntu-worker1 (CP)
  "ubuntu@10.2.2.78"   # k3s-ubuntu-worker2 (CP)
  "ubuntu@10.2.2.128"  # k3s-ubuntu-worker3 (worker)
  "ubuntu@10.2.2.210"  # k3s-ubuntu-worker4 (worker)
)

echo "==> Building $IMAGE"
cd "$(dirname "$0")"

# Install deps if needed
if [ ! -d node_modules ]; then
  echo "==> Installing dependencies"
  npm ci
fi

# Generate Prisma client
echo "==> Generating Prisma client"
npx prisma generate

# Build image
echo "==> Building Docker image"
docker build --platform linux/amd64 -t "$IMAGE" -t "orion:latest" .

# Save image once; reuse for both local import and remote distribution
echo "==> Saving image to tarball..."
TARBALL=$(mktemp /tmp/orion-XXXXXX.tar)
docker save orion:latest > "$TARBALL"

# Import into THIS node's k3s containerd (homelab-master)
# K3s CP nodes use /run/k3s/containerd/containerd.sock — not the system containerd
echo "==> Importing into local k3s containerd (homelab-master)"
sudo ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import - < "$TARBALL"

# Distribute to all other amd64 nodes in parallel
echo "==> Distributing to cluster nodes in parallel..."

pids=()
for NODE in "${NODES[@]}"; do
  (
    echo "  -> $NODE"
    # Try k3s socket first (CP nodes), fall back to system containerd (plain workers)
    cat "$TARBALL" | ssh -o StrictHostKeyChecking=no "$NODE" \
      "sudo ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import - 2>/dev/null \
       || sudo ctr -n k8s.io images import -"
    echo "  ✓ $NODE"
  ) &
  pids+=($!)
done

# Wait for all background imports and check for failures
failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=$((failed + 1))
done

rm -f "$TARBALL"

if [ "$failed" -gt 0 ]; then
  echo "WARNING: $failed node(s) failed to import the image — check SSH access"
fi

echo ""
echo "==> Built and distributed: $IMAGE"
echo "==> Deploying:"
kubectl rollout restart deployment/orion -n management
kubectl rollout status deployment/orion -n management --timeout=120s
