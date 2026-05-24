# ORION Security & Compliance Reference

**Last updated**: 2026-05-24
**Scope**: ORION Web + Gateway
**Framework**: SOC 2 Type II — Trust Service Criteria

---

## Current Posture

Phase 1 remediation complete (~95%). Phase 2/3 SIEM (PRs #436–#444) reviewed 2026-05-23 — no new CRITICAL or HIGH findings introduced.

| ID | Finding | Status |
|----|---------|--------|
| C1 | Setup wizard hardcoded fallback secret | OPEN |
| C2 | Gitea admin credentials exposure | OPEN |
| C3 / INPUT-001 | Input validation gap (74 routes) | PARTIAL — 55% done |
| C4 / AUDIT-001 | Audit log tamper-proofing | COMPLETE |
| H1 | Plaintext secrets in DB | OPEN (envelope encryption deferred) |
| H2 | CSP / security headers | COMPLETE |
| H3 | Path traversal in domain setup | COMPLETE |
| H5 | Shell injection filter | COMPLETE |
| H7 | `kubectl_apply_url` SSRF | OPEN |
| H13 | AuditLog coverage gaps | PARTIAL |
| M1 | SQL injection → Prisma parameterized queries | COMPLETE |
| M2 | Secure cookie flags | COMPLETE |
| M3 / RATE-001 | Rate limiting | COMPLETE |
| M4 | Sensitive data in logs | PARTIAL |
| M5 | Missing audit fields on some models | PARTIAL |
| SSO-001 | SSO header injection | COMPLETE |

**Open items requiring action**:
- **C3**: Admin routes still need Zod validation — `POST /api/admin/users`, `PUT /api/admin/users/[id]`, `PATCH /api/admin/settings`, `PUT /api/admin/system-prompts/[key]`
- **C1**: Wizard fallback — architectural decision pending
- **H1**: Envelope encryption — deferred; no timeline
- **H7**: `kubectl_apply_url` SSRF — open; scoped to URL-taking gateway tools only
- **CR-003**: K8s stream/pod-logs endpoint auth — confirm middleware coverage

**Key security files**:

| File | Purpose |
|------|---------|
| `apps/web/src/middleware.ts` | Rate limiting + CSP headers |
| `apps/web/src/lib/rate-limit-redis.ts` | Redis sliding-window rate limiter |
| `apps/web/src/lib/auth.ts` | NextAuth config + SSO HMAC validation |
| `apps/web/src/lib/redact.ts` | Secret redaction patterns |
| `apps/web/src/lib/validate.ts` | Zod schemas + `parseBodyOrError` helper |
| `apps/web/src/lib/audit-export.ts` | S3 audit log export |
| `apps/gateway/src/tool-runner.ts` | Tool execution + injection prevention |

---

## Phase 2/3 SIEM — Security Review

**PRs #436–#444 | Reviewed 2026-05-23 | Self-review; re-validate before formal Type II audit**

All new boundaries validated with Zod, argv-array `execFile` (no shell), and regex input gates. No new CRITICAL/HIGH findings. Three deliberate exceptions:

| Exception | Mitigation |
|-----------|-----------|
| Falco runs `privileged: true` on every host | Required for eBPF syscall capture; host mounts are all read-only (`/proc`, `/boot`, `/lib/modules`, `/usr`, `/etc` all `:ro`); pinned to `falcosecurity/falco-no-driver:0.38.2` |
| Single shared `FALCO_WEBHOOK_SECRET` across fleet | Per-env rotation via Vault is tracked as a Phase 2.5 follow-up |
| NVD CVE enrichment is best-effort | Findings ship with partial enrichment if NVD is unavailable; scans are never blocked |

**Hardening follow-up**: `IMAGE_REF_RE` accepts a leading `-` (e.g. `-rm`), which Trivy would reject as an unknown flag rather than execute. Add a `^[A-Za-z0-9]` prefix guard as a Phase 3.5 item.

---

## AUDIT-001 — S3 Audit Log Export

**Status**: Implementation complete — pending S3 bucket setup by ops

Audit logs older than the retention period (default 30 days) are exported to S3 as gzipped JSON with a SHA-256 hash chain, then deleted from the DB. Runs automatically at 2 AM UTC; triggerable on demand.

**Files**: `apps/web/src/lib/audit-export.ts`, `apps/web/src/jobs/audit-export-daily.ts`, `apps/web/src/app/api/admin/audit-export/route.ts`, `apps/web/src/app/api/admin/audit-retention/cleanup/route.ts`

### Environment variables

```bash
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs-prod
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_RETENTION_DAYS=30
AUDIT_EXPORT_MANIFEST_PATH=manifests/
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
AUDIT_EXPORT_S3_ENDPOINT=              # non-AWS backends only
AUDIT_EXPORT_S3_BACKEND=auto           # auto|minio|aws|digitalocean|wasabi|custom
AUDIT_EXPORT_S3_FORCE_PATH_STYLE=false # custom backends only
```

### Backend selection

| Backend | Cost | Best for |
|---------|------|---------|
| MinIO | $0 | Homelab / self-hosted |
| AWS S3 | $0.023/GB | Production — use Object Lock COMPLIANCE |
| DigitalOcean Spaces | $5/mo flat (250 GB) | Small cloud deployments |
| Wasabi | $0.006/GB | Cold archive |

**MinIO quick-start** — add to `docker-compose.yml`:
```yaml
minio:
  image: minio/minio:latest
  ports: ["9000:9000", "9001:9001"]
  environment:
    MINIO_ROOT_USER: minioadmin
    MINIO_ROOT_PASSWORD: change-me-securely
  volumes: [minio_data:/data]
  command: minio server /data
```
```bash
aws s3 mb s3://orion-audit-logs --endpoint-url http://localhost:9000 --region us-east-1
# .env: AUDIT_EXPORT_S3_BACKEND=minio, AUDIT_EXPORT_S3_ENDPOINT=http://minio:9000
```

**AWS S3 setup**:
```bash
aws s3api create-bucket --bucket orion-audit-logs-prod --region us-east-1 --object-lock-enabled-for-bucket
aws s3api put-object-lock-configuration --bucket orion-audit-logs-prod \
  --object-lock-configuration 'ObjectLockEnabled=Enabled,Rule={DefaultRetention={Mode=COMPLIANCE,Days=2555}}'
aws iam create-user --user-name orion-s3-user
aws iam create-access-key --user-name orion-s3-user
# IAM policy: s3:ListBucket + s3:GetBucketLocation on bucket ARN; s3:PutObject on bucket/*, 
```

### Usage

```bash
# Manual export
curl -X POST https://{app}/api/admin/audit-export -H "Authorization: Bearer {token}"

# Check job status
curl "https://{app}/api/admin/audit-export?jobId={jobId}" -H "Authorization: Bearer {token}"

# Cleanup with auto-export verification
curl -X POST https://{app}/api/admin/audit-retention/cleanup -H "Authorization: Bearer {token}"

# Verify daily job
SELECT * FROM "BackgroundJob" WHERE type = 'audit-export-daily' ORDER BY "createdAt" DESC LIMIT 1;
```

### Manifest format

```
s3://bucket/YYYY-MM-DD/audit-logs-YYYY-MM-DD.json.gz   ← logs
s3://bucket/manifests/manifest-YYYY-MM-DD.json          ← manifest
```

```json
{
  "exportDate": "2026-04-26T02:00:00Z",
  "recordCount": 1523,
  "dateRange": { "start": "2026-02-25", "end": "2026-04-25" },
  "s3Path": "s3://orion-audit-logs-prod/2026-04-26/audit-logs-2026-04-26.json.gz",
  "hashChain": {
    "logs": "<sha256-of-gzip-file>",
    "manifest": "<sha256-of-this-manifest-minus-hash-fields>",
    "previousManifest": "<sha256-of-prior-day-manifest>"
  }
}
```

Hash chain verification: remove `manifest` and `previousManifest` fields, SHA-256 the remaining JSON, compare to `hashChain.manifest`.

### Deployment checklist

- [ ] S3 bucket created with versioning + lifecycle policy (7-year retention)
- [ ] Object Lock COMPLIANCE enabled (AWS) or equivalent immutability strategy documented
- [ ] All env vars set; `docker compose up -d orion`
- [ ] Manual export triggered and files confirmed in S3
- [ ] Manifest hash chain verified manually
- [ ] Day-2 manifest `previousManifest` links to day-1 manifest
- [ ] Export logged in AuditLog: `SELECT * FROM "AuditLog" WHERE target = 'audit_log_export'`

---

## SSO-001 — HMAC-SHA256 SSO Header Validation

**Status**: COMPLETE | **File**: `apps/web/src/lib/auth.ts`

Prevents header-injection privilege escalation via SSO auto-provisioning. The reverse proxy signs headers; the app validates the signature before trusting any SSO identity.

**Canonical string**: `username|email|name|uid|timestamp_ms` (fields joined with `|`, order is fixed)
**Signature header**: `x-authentik-hmac`
**Timestamp header**: `x-authentik-timestamp` (Unix milliseconds)
**Replay window**: 30 seconds (±5s clock skew tolerance)

### Environment variables

```bash
SSO_HMAC_SECRET=<32-byte hex>           # openssl rand -hex 32
SSO_HMAC_SECRET_PREVIOUS=<old-secret>   # during key rotation only
```

Backward compatible: if `SSO_HMAC_SECRET` is unset, unsigned SSO is allowed with a log warning.

### Key rotation (every 90 days)

1. Generate new secret on reverse proxy
2. Set `SSO_HMAC_SECRET_PREVIOUS=<old>` + `SSO_HMAC_SECRET=<new>` on the app; restart
3. Wait 5 minutes for proxy to reload with the new secret
4. Remove `SSO_HMAC_SECRET_PREVIOUS`; restart app

### Authentik configuration

In Authentik Admin: **Flows & Stages → Stages** → add a custom attributes stage:
```javascript
const crypto = require('crypto');
const secret = context.request.environ.get('SSO_HMAC_SECRET');
const timestamp = Math.floor(Date.now() / 1000) * 1000;
const canonical = `${user.username}|${user.email}|${user.name || ''}|${user.pk}|${timestamp}`;
const hmac = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
context.x_authentik_hmac = hmac;
context.x_authentik_timestamp = timestamp;
```
Forward headers: `x-authentik-username`, `x-authentik-email`, `x-authentik-name`, `x-authentik-uid`, `x-authentik-timestamp`, `x-authentik-hmac`.

### Testing

```bash
SECRET="your-secret"
TIMESTAMP=$(date +%s000)
CANONICAL="alice|alice@example.com|Alice Smith|user-123|${TIMESTAMP}"
HMAC=$(echo -n "$CANONICAL" | openssl dgst -sha256 -mac HMAC -macopt "key:$SECRET" -hex | cut -d' ' -f2)

# Valid — expect 200
curl -i http://localhost:3000/api/profile \
  -H "x-authentik-username: alice" -H "x-authentik-email: alice@example.com" \
  -H "x-authentik-name: Alice Smith" -H "x-authentik-uid: user-123" \
  -H "x-authentik-timestamp: $TIMESTAMP" -H "x-authentik-hmac: $HMAC"

# Invalid HMAC — expect 401
curl -i http://localhost:3000/api/profile \
  -H "x-authentik-username: alice" -H "x-authentik-hmac: deadbeef"
```

Failures logged as `user_login_failure` / `target: sso-header-auth` / `detail.reason: invalid_hmac`.

---

## RATE-001 — Distributed Rate Limiting

**Status**: COMPLETE | **Files**: `apps/web/src/lib/rate-limit-redis.ts`, `apps/web/src/middleware.ts`

Redis sliding-window rate limiter applied to all `/api/*` routes via middleware. Falls back to in-memory Map if Redis is unavailable (not shared across instances).

### Configuration (choose one)

```bash
# Standard Redis
REDIS_URL=redis://localhost:6379/0

# Upstash (serverless)
UPSTASH_REDIS_URL=redis://:token@host.upstash.io

# Redis Sentinel (HA — production recommended)
REDIS_SENTINEL_MASTER=mymaster
REDIS_SENTINEL_NODES=sentinel1:26379,sentinel2:26379,sentinel3:26379
REDIS_SENTINEL_PASSWORD=<optional>
REDIS_PASSWORD=<optional>
```

### Rate limits

| Path pattern | Limit | Window |
|-------------|-------|--------|
| Auth (`/login`, `/api/setup`, `/api/auth`) | 10 req | 15 min |
| Chat/LLM (`/api/chat`, `/api/k8s`) | 30 req | 15 min |
| Webhooks (`/api/webhooks`) | 60 req | 15 min |
| Tool generation (`/api/tools/generate`) | 20 req | 15 min |
| Default | 100 req | 15 min |

Rate-limited responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers.

---

## INPUT-001 — Zod Input Validation

**Status**: IN PROGRESS — 55% complete

**Infrastructure complete**: `apps/web/src/lib/validate.ts` — `parseBodyOrError` helper + 18 schemas.

### Pattern

```typescript
import { parseBodyOrError, CreateUserSchema } from '@/lib/validate'

const result = await parseBodyOrError(req, CreateUserSchema)
if ('error' in result) return result.error
const { data } = result  // type-safe, validated
```

### Completed routes (14)

Auth TOTP/MFA (`/api/auth/totp/verify|disable|recovery`, `/api/auth/mfa/verify`, `/api/auth/totp-login`), agents (`/api/agents`, `/api/agents/[id]`), tasks (`/api/tasks`, `/api/tasks/[id]`), features and epics.

### Remaining TODO

**Batch 2 — admin routes (~30 min)**:
- `POST /api/admin/users` → `CreateUserSchema`
- `PUT /api/admin/users/[id]` → `UpdateUserSchema`
- `PATCH /api/admin/settings` → `UpdateSettingsSchema`
- `PUT /api/admin/system-prompts/[key]` → `UpdateSystemPromptSchema`

**Batch 3 — optional**:
- `POST /api/notes`, `PUT /api/notes/[id]`, `PUT /api/conversations/[id]`

---

## SIEM Telemetry Sources & Secret Rotation

| Source | Producer | Auth | Secret |
|--------|----------|------|--------|
| `host_agent` | Vector (`deploy/host-agent/vector.toml`) | HMAC-SHA256, `X-Signature: sha256=<hex>` | `HOST_AGENT_WEBHOOK_SECRET` env var |
| `falco` | Falcosidekick | Bearer token, `X-Orion-Falco-Signature` | `FALCO_WEBHOOK_SECRET` env var |
| `gateway_audit` | Gateway dispatcher (`gateway-audit.ts`) | HMAC over body | `GATEWAY_AUDIT_SECRET` env var |
| `crowdsec` / `wazuh` | External (not deployed) | HMAC per source | `SecurityConfig` DB row |
| `elk` / `ntopng` | Internal pollers | n/a (in-process) | n/a |
| `k8s_events` | In-process poller | n/a (per-env gateway auth) | n/a |

`HOST_AGENT_WEBHOOK_SECRET` is load-bearing from the env var — the `SecurityConfig` DB row exists for reference only; don't rely on it alone.

### Rotating HOST_AGENT_WEBHOOK_SECRET

Both Vector (producer) and ORION (verifier) read the same env var and must restart together.

```bash
openssl rand -hex 32  # generate new value
# Update deploy/.env — replace HOST_AGENT_WEBHOOK_SECRET=... line
# Optional: vault kv put secret/orion/host-agent webhook_secret=<new>
docker compose up -d orion vector
```

### Rotating FALCO_WEBHOOK_SECRET

Single secret shared by all Falcosidekick instances (Orion host + every managed env). Plan during low-activity windows.

```bash
openssl rand -hex 32  # generate new value
# Update deploy/.env
vault kv put secret/orion/falco webhook_secret=<new>
docker compose up -d orion falcosidekick
# For each managed env: redeploy Falcosidekick (compose fragment or Helm) with new secret
```

Until a managed env is updated, its alerts will 401 against the ORION route.

### Falco deployment artifacts

| Target | Artifact |
|--------|---------|
| Orion host | `falco` + `falcosidekick` services in `deploy/docker-compose.yml`; config at `deploy/host-agent/falco/falco.yaml` |
| Managed Docker | `deploy/managed-env/falco/docker-compose.fragment.yml` |
| Managed K8s | `deploy/managed-env/falco/falco-helm-values.yaml` (`helm install falco falcosecurity/falco`) |

**Verify events arrive**: `docker exec -it <any-container> bash` → expect a `falco.terminal_shell_in_container` SecurityEvent within ~5 seconds.
