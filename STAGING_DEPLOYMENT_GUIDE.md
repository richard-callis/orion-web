# ORION Staging Deployment Guide

This guide provides step-by-step instructions for deploying ORION with all SOC II compliance requirements on a staging environment.

**Current Status**: ORION staging environment includes:
- All 7 SOC II security fixes from recent PRs (#137, #135, #123, etc.)
- MinIO for S3-compatible audit log archival
- Redis Sentinel cluster for distributed rate limiting (HA with quorum)
- PostgreSQL with audit logging
- HashiCorp Vault for secret management
- Full encryption at rest and in transit

---

## Quick Start

### 1. Copy Staging Environment File

```bash
cd /opt/orion/deploy
cp .env.example .env.staging  # Already pre-configured
```

Review critical values in `.env.staging`:
- `POSTGRES_PASSWORD` — Set a strong password
- `NEXTAUTH_SECRET` — Keep as-is for staging, change for production
- `MANAGEMENT_IP` — Set to your host IP (default: 127.0.0.1 for local)
- MinIO credentials: `minioadmin/minioadmin` (staging default)

### 2. Start All Services

```bash
cd /opt/orion/deploy

# With Gitea bundled (recommended for first-run setup)
docker-compose --profile gitea -f docker-compose.yml \
  --env-file .env.staging up -d

# Without Gitea (if using GitHub/GitLab)
docker-compose -f docker-compose.yml \
  --env-file .env.staging up -d
```

### 3. Verify Services Are Healthy

```bash
docker-compose -f docker-compose.yml ps

# Should show all services as "healthy" or "running" within 30-60s
# Use: docker-compose logs <service-name> to view startup logs
```

---

## Service Ports & Health Checks

| Service | Port | Type | Health Check |
|---------|------|------|-------------|
| **ORION Web** | 3000 | HTTP | `curl http://localhost:3000/api/health` |
| **MinIO API** | 9000 | S3 | `curl http://localhost:9000/minio/health/live` |
| **MinIO Console** | 9001 | Web UI | `http://localhost:9001` |
| **Redis Master** | 6379 | TCP | `redis-cli -p 6379 ping` |
| **Redis Sentinel 1** | 26379 | TCP | `redis-cli -p 26379 sentinel masters` |
| **Redis Sentinel 2** | 26380 | TCP | `redis-cli -p 26380 sentinel masters` |
| **Redis Sentinel 3** | 26381 | TCP | `redis-cli -p 26381 sentinel masters` |
| **PostgreSQL** | 5432 | PostgreSQL | `pg_isready -h 127.0.0.1 -p 5432` |
| **Vault** | 8200 | HTTPS | `curl http://localhost:8200/v1/sys/health` |
| **Gitea** (optional) | 3002 | HTTP | `curl http://localhost:3002` |
| **CoreDNS** | 53 | DNS | `nslookup example.com @127.0.0.1` |

---

## Startup Sequence & Expected Timeline

**Total startup time: ~30-60 seconds**

### Phase 1: Core Infrastructure (5-10s)
1. PostgreSQL starts and initializes
2. Vault initializes (may require unsealing)
3. MinIO starts object storage

### Phase 2: Initialization (10-15s)
1. MinIO bucket creation (`minio-init` container)
2. Redis Master starts
3. Redis Sentinel instances start and discover master

### Phase 3: Application (15-30s)
1. Vault unsealer retrieves keys
2. ORION application container starts
3. Gateway registers with ORION (if included)

### Phase 4: Ready (30-60s)
1. All health checks pass
2. Services ready for testing

**Check real-time progress:**
```bash
docker-compose logs -f <service-name>  # Follow logs for a service
docker-compose logs --tail 50            # View last 50 lines all services
```

---

## Manual Testing of Each Component

### MinIO (S3-Compatible Storage)

#### Setup MinIO CLI (`mc`)
```bash
# If not installed, install via: brew install minio/stable/mc
mc alias set staging http://localhost:9000 minioadmin minioadmin
```

#### Verify Bucket & Versioning
```bash
# List buckets
mc ls staging

# Check bucket exists
mc ls staging/orion-audit-logs

# Verify versioning is enabled
mc version info staging/orion-audit-logs
```

#### Upload Test File
```bash
echo "test audit log" > test-log.txt
mc cp test-log.txt staging/orion-audit-logs/
```

#### Browse MinIO Console
```
http://localhost:9001
Username: minioadmin
Password: minioadmin
```

---

### Redis & Sentinel

#### Test Redis Master
```bash
# Connect to Redis and ping
redis-cli -p 6379 ping
# Expected: PONG

# Check info
redis-cli -p 6379 info server | grep redis_version
```

#### Test Sentinel 1
```bash
# Query Sentinel for master information
redis-cli -p 26379 sentinel masters
# Expected: mymaster configuration

# Get master address
redis-cli -p 26379 sentinel get-master-addr-by-name mymaster
# Expected: [redis-master, 6379]
```

#### Test Sentinel 2
```bash
redis-cli -p 26380 sentinel masters
redis-cli -p 26380 sentinel get-master-addr-by-name mymaster
```

#### Test Sentinel 3
```bash
redis-cli -p 26381 sentinel masters
redis-cli -p 26381 sentinel get-master-addr-by-name mymaster
```

#### Simulate Failover (Optional)
```bash
# In a separate terminal, get into Redis container
docker exec -it <redis-master-container> redis-cli

# Inside Redis, shut down the server
SHUTDOWN

# Observe Sentinels promoting a replica (if replicas are running)
# Check which instance becomes new master
redis-cli -p 26379 sentinel masters
```

---

### PostgreSQL

#### Connect to Database
```bash
# Connect as orion user
psql -h 127.0.0.1 -U orion -d orion -c "SELECT version();"

# Expected: PostgreSQL 16 with pgvector
```

#### Verify Audit Tables
```bash
psql -h 127.0.0.1 -U orion -d orion -c "\dt audit*"
# Should show AuditLog and related tables
```

#### Check Audit Log Entries
```bash
psql -h 127.0.0.1 -U orion -d orion -c "SELECT COUNT(*) FROM \"AuditLog\";"
# Should return row count
```

---

### ORION Web API

#### Health Check
```bash
curl -i http://localhost:3000/api/health
# Expected: HTTP 200 OK
```

#### Check Auth Status
```bash
curl -i http://localhost:3000/api/auth/session
# Expected: HTTP 200 with session info (or 401 if not authenticated)
```

#### List Audit Logs
```bash
curl -i http://localhost:3000/api/admin/audit-logs \
  -H "Authorization: Bearer <your-token>"
# Returns paginated audit logs with tamper-evidence hash chain
```

---

### Vault

#### Check Vault Status
```bash
curl http://localhost:8200/v1/sys/health
# Expected: HTTP 200 with health info
```

#### View Audit Device
```bash
vault audit list -address=http://127.0.0.1:8200
# Expected: file audit backend at path /var/log/vault/audit.log
```

---

## Container Logs & Troubleshooting

### View Logs for a Service
```bash
# Follow logs in real-time (last 100 lines)
docker-compose logs -f --tail 100 orion

# View logs for MinIO init
docker-compose logs minio-init

# View Redis Sentinel logs
docker-compose logs redis-sentinel-1
```

### Check Container Health
```bash
docker-compose ps  # Show all containers and their status

docker inspect <container-id> | grep -A 20 "Health"  # Detailed health info
```

---

## Common Issues & Solutions

### 1. "minio-init: Cannot connect to minio"

**Cause**: MinIO not fully started yet.

**Solution**:
```bash
# Wait for MinIO to be healthy
docker-compose logs minio  # Check for health issues

# Restart just minio-init
docker-compose restart minio-init
```

### 2. "Redis Sentinel: Could not resolve hostname redis-master"

**Cause**: Docker DNS resolution issue or Redis not started.

**Solution**:
```bash
# Ensure Redis is running
docker-compose ps | grep redis-master

# Check Sentinel logs
docker-compose logs redis-sentinel-1

# Restart both Redis and Sentinels
docker-compose restart redis-master redis-sentinel-1 redis-sentinel-2 redis-sentinel-3
```

### 3. "ORION container: Database connection refused"

**Cause**: PostgreSQL not ready or incorrect password.

**Solution**:
```bash
# Check PostgreSQL is running
docker-compose ps | grep postgres

# Verify password in .env.staging matches docker-compose.yml
grep POSTGRES_PASSWORD .env.staging

# Try direct connection
psql -h 127.0.0.1 -U orion -d orion -c "SELECT 1"
# If fails, check postgres logs
docker-compose logs postgres
```

### 4. "Vault: Permission denied when reading config"

**Cause**: Vault data directory permissions.

**Solution**:
```bash
# The vault-init container should fix this automatically
docker-compose logs vault-init

# If needed, manually fix permissions
docker exec vault-init chown -R 100:1000 /vault/data

# Restart Vault
docker-compose restart vault vault-unsealer
```

### 5. "Rate limiting not working / In-memory fallback active"

**Cause**: Redis Sentinel connection not established.

**Solution**:
```bash
# Verify Sentinel is responding
redis-cli -p 26379 sentinel masters

# Check ORION logs for connection errors
docker-compose logs orion | grep -i redis

# Verify environment variables are passed correctly
docker-compose config | grep REDIS_SENTINEL
```

---

## SOC II Configuration Validation

### Checklist: Verify All SOC II Requirements

```bash
# 1. Audit Log Archival (L-001)
redis-cli -p 6379 GET "audit:export:last_run"  # Should return a timestamp

# 2. Audit Log Tamper-Evidence (L-001)
psql -h 127.0.0.1 -U orion -d orion \
  -c "SELECT id, hash, prev_hash FROM \"AuditLog\" LIMIT 1"
# prev_hash should match previous log's hash (hash chain)

# 3. Redis Sentinel HA (RATE-001)
redis-cli -p 26379 sentinel masters
# Should show quorum=2, all sentinels connected

# 4. Encryption at Rest (SEC-001)
psql -h 127.0.0.1 -U orion -d orion \
  -c "SELECT id, secret FROM \"Secret\" LIMIT 1"
# secret should be encrypted (base64/binary, not plaintext)

# 5. All Health Checks Passing
docker-compose ps | grep healthy
# All services should show "healthy" or "running"
```

---

## Stopping & Cleanup

### Stop All Services (Keep Data)
```bash
cd /opt/orion/deploy
docker-compose -f docker-compose.yml down
# Data persists in Docker volumes
```

### Stop & Remove All Data (Full Reset)
```bash
cd /opt/orion/deploy
docker-compose -f docker-compose.yml down -v
# WARNING: This deletes all persistent volumes!
```

### Restart a Single Service
```bash
docker-compose restart <service-name>
# e.g., docker-compose restart orion
```

---

## Performance Tuning (Optional)

### Redis Memory Configuration
```bash
# View current Redis memory settings
redis-cli -p 6379 config get maxmemory

# Set max memory (e.g., 1GB)
redis-cli -p 6379 config set maxmemory 1gb

# Set eviction policy (LRU for rate limiting)
redis-cli -p 6379 config set maxmemory-policy allkeys-lru
```

### MinIO Performance
```bash
# Enable compression for audit logs (in MinIO console)
# Storage > Buckets > orion-audit-logs > Edit Configuration > Compression

# Monitor disk usage
mc du staging/orion-audit-logs
```

### PostgreSQL Tuning
```bash
# Check current settings
psql -h 127.0.0.1 -U orion -d orion -c "SHOW shared_buffers;"

# Adjust in docker-compose.yml environment section:
# PostgreSQL container doesn't expose POSTGRESQL_CONF override yet,
# but you can mount a postgresql.conf file if needed for heavy load
```

---

## Next Steps: Production Deployment

1. **Secrets Management**:
   - Replace all `staging-*` defaults with production values
   - Use `openssl` to generate strong secrets
   - Store in HashiCorp Vault or encrypted CI/CD secrets

2. **TLS Configuration**:
   - Enable HTTPS for ORION, MinIO, and Vault
   - Use Let's Encrypt or internal CA certificates
   - Configure Traefik for SSL termination

3. **Backup & Disaster Recovery**:
   - Implement daily backup of PostgreSQL
   - Backup MinIO buckets to offsite S3
   - Test restore procedures weekly

4. **Monitoring & Alerting**:
   - Enable Prometheus metrics on all services
   - Set up Grafana dashboards
   - Configure alerts for service failures

5. **Compliance Auditing**:
   - Review audit logs regularly
   - Validate tamper-evidence hash chains monthly
   - Test failover procedures quarterly

---

## Quick Reference: Docker Compose Commands

```bash
cd /opt/orion/deploy

# Start services with staging environment
docker-compose --env-file .env.staging up -d

# View status of all services
docker-compose ps

# View logs for a specific service
docker-compose logs -f <service-name>

# Execute command in running container
docker exec <container-id> <command>

# Restart a service
docker-compose restart <service-name>

# Stop all services (keep data)
docker-compose down

# Rebuild an image (if you modified Dockerfile)
docker-compose build <service-name>

# Remove unused images and volumes
docker image prune
docker volume prune

# Validate docker-compose.yml syntax
docker-compose config
```

---

## Contact & Support

For issues or questions:
1. Check container logs: `docker-compose logs <service>`
2. Review SOC II findings: `/opt/orion/SOC2_REMEDIATION_PLAN.md`
3. Check ORION documentation: `/opt/orion/docs/`

---

**Last Updated**: 2026-04-26  
**ORION Version**: latest  
**Status**: SOC II compliance staging environment, ready for testing
