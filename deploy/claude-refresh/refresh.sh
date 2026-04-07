#!/bin/sh
set -e

# If credentials are pre-seeded via bind mount, symlink them to Claude's expected location
if [ -f /claude-creds/.claude/.credentials.json ]; then
  mkdir -p /root/.claude
  cp /claude-creds/.claude/.credentials.json /root/.claude/.credentials.json
fi

echo "[claude-refresh] Starting credential refresh loop (interval: 6h)"

while true; do
  echo "[claude-refresh] $(date): Refreshing Claude credentials..."

  # Run a lightweight claude operation to trigger token refresh
  # claude --version just checks the CLI works; the SDK auto-refreshes on any invocation
  if claude --version > /dev/null 2>&1; then
    echo "[claude-refresh] Token refresh succeeded"
    # Copy refreshed credentials back to shared volume
    if [ -f /root/.claude/.credentials.json ]; then
      mkdir -p /claude-creds/.claude
      cp /root/.claude/.credentials.json /claude-creds/.claude/.credentials.json
      echo "[claude-refresh] Credentials written to /claude-creds/.claude/.credentials.json"
    fi
  else
    echo "[claude-refresh] Warning: claude invocation failed — credentials may need manual re-auth"
  fi

  echo "[claude-refresh] Next refresh in 6 hours"
  sleep 21600
done
