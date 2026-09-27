#!/bin/sh
# Get the IP address of redis-master and update sentinel config
echo "Resolving redis-master hostname to IP..."
MAX_RETRIES=60
RETRY_COUNT=0

REDIS_MASTER_IP=""
while [ -z "$REDIS_MASTER_IP" ]; do
  # Try to resolve redis-master using getent
  REDIS_MASTER_IP=$(getent hosts redis-master 2>/dev/null | awk '{ print $1 }' | head -1)

  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "ERROR: Could not resolve redis-master after $MAX_RETRIES attempts"
    exit 1
  fi

  if [ -z "$REDIS_MASTER_IP" ]; then
    if [ $((RETRY_COUNT % 10)) -eq 0 ]; then
      echo "Still resolving redis-master... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    fi
    sleep 1
  fi
done

echo "Resolved redis-master to IP: $REDIS_MASTER_IP"

# Copy config to writable location and update with resolved IP
cp /etc/redis-sentinel.conf /data/redis-sentinel.conf.tmp
sed -i "s/redis-master/$REDIS_MASTER_IP/g" /data/redis-sentinel.conf.tmp

echo "Updated sentinel config with resolved IP"

# The master requires a password (requirepass). Without auth-pass the sentinels
# could never authenticate, so they marked the master +sdown and never saw each
# other or any replica. REDIS_PASSWORD is hex (bootstrap.sh), safe unquoted.
if [ -n "${REDIS_PASSWORD:-}" ]; then
  echo "sentinel auth-pass mymaster ${REDIS_PASSWORD}" >> /data/redis-sentinel.conf.tmp
  echo "Configured sentinel auth for mymaster"
else
  echo "WARNING: REDIS_PASSWORD not set — sentinel cannot authenticate to the master"
fi
sleep 1

echo "Starting sentinel..."
exec redis-sentinel /data/redis-sentinel.conf.tmp
