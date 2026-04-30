# SOC2 Implementation Guide — ORION

**Last Updated**: 2026-04-26
**Purpose**: How-to reference for SOC2 remediation — architecture decisions, implementation patterns, deployment procedures, and test verification.

---

## 1. Architecture Decisions (Opus-Approved)

Reviewed and approved 2026-04-26 by Opus 4.6.

### Decision 1: INPUT-001 — Input Validation Strategy

**Approved**: Hybrid tier approach (NOT all 91+ routes at once)

**Tier 1 — Must Validate (25-30 routes)**:
- `/api/auth/*` — CredentialsProvider login, MFA, recovery codes
- `/api/admin/*` — User/setting/prompt management
- `/api/setup/*` — Initial setup routes
- `/api/api-keys/*` — API key operations
- `/api/chat/conversations` (POST/PATCH) — Message creation/updates
- `/api/agents` (POST/PUT) — Agent CRUD
- `/api/tasks` (POST/PUT) — Task CRUD
- `/api/features`, `/api/epics`, `/api/bugs` — Planning CRUD
- `/api/notes` (POST/PUT) — Knowledge base mutations
- `/api/environments` (POST/PUT) — Environment CRUD
- `/api/tool-groups`, `/api/tool-approvals` — Tool access control

**Tier 2 — Should Validate**: Internal service routes with Bearer auth (`/api/environments/[id]/sync-status`, etc.)

**Tier 3 — Skip**: All GET routes, `/api/k8s/stream`, `/api/health`

**Implementation Notes**:
- Use existing `lib/validate.ts` — already has `CreateConversationSchema`, `CreateEnvironmentSchema`, `CreateAgentSchema`, `SetupAdminSchema`, etc.
- Derive schemas from `context/schema.md` Prisma models
- String length constraints are critical for SOC2 — even without full schemas, `.max()` on strings prevents storage DoS
- For updates (PUT/PATCH): use `.partial()` on create schemas
- **Do NOT touch all 91 files simultaneously** — massive regression risk

**Helper function** (`lib/validate.ts`):
```typescript
export async function parseBodyOrError<T>(
  req: NextRequest,
  schema: z.ZodSchema<T>
): Promise<{ data: T } | { error: NextResponse }> {
  try {
    const body = await req.json()
    const data = schema.parse(body)
    return { data }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        error: NextResponse.json(
          { error: 'Invalid request body', issues: err.issues },
          { status: 400 }
        )
      }
    }
    return { error: NextResponse.json({ error: 'Bad request' }, { status: 400 }) }
  }
}

// Usage in route:
export async function POST(req: NextRequest) {
  const result = await parseBodyOrError(req, conversationSchema)
  if ('error' in result) return result.error
  const { data } = result  // type-safe T
  // ... proceed with data
}
```

---

### Decision 2: AUDIT-001 — Audit Log Retention

**Approved**: Export to S3 with Object Lock before deletion

**Retention Period**: 12 months (365 days) — SOC2 minimum; your code already enforces via `getRetentionDays()`

**Archival Strategy**:
1. **Export Phase**: Daily job exports logs older than `retentionDays - 30` as NDJSON to S3
   - Key pattern: `audit-archive/YYYY/MM/batch-{timestamp}.jsonl.gz`
   - 30-day overlap window prevents gaps if export fails
2. **Delete Phase**: Existing cleanup only deletes after export confirms success
3. **Manifest**: Each batch gets a manifest file with hash of first record, hash of last record, SHA-256 digest of archive file
4. **S3 Object Lock (WORM)**: Enable on both archive + manifest files

**CRITICAL**: Current `audit-cleanup.ts` deletes without archiving first. **Build S3 export step BEFORE enabling automated cleanup in production.** Manual cleanup route must verify archive is current.

Hash chain continuity: last hash of batch N = `previousHash` of first record in batch N+1.

---

### Decision 3: SSO-001 — HMAC-SHA256 Validation (PROMOTED TO P0)

**Status**: ✅ COMPLETE — implemented in `fix/sso-header-hmac-validation`

**Why P0**: Header injection in `lib/auth.ts:198-224` is exploitable today if attacker bypasses proxy — any username header → auto-provisioned user.

**Canonical string format**:
```
x-authentik-username|x-authentik-email|x-authentik-name|x-authentik-uid|timestamp
```

**Validation logic** (`lib/auth.ts`):
```typescript
import { timingSafeEqual } from 'crypto'

async function validateSSoHeaderHmac(headers: Headers): Promise<boolean> {
  const secret = process.env.SSO_HMAC_SECRET
  if (!secret) return false
  const username = headers.get('x-authentik-username')
  const timestamp = headers.get('x-authentik-timestamp')
  const signature = headers.get('x-authentik-hmac')
  if (!username || !timestamp || !signature) return false
  const ts = parseInt(timestamp, 10)
  if (isNaN(ts) || Date.now() - ts > 30_000) return false
  const canonical = [username, headers.get('x-authentik-email'),
    headers.get('x-authentik-name'), headers.get('x-authentik-uid'), timestamp].join('|')
  const expected = createHmac('sha256', secret).update(canonical).digest('hex')
  try {
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    return true
  } catch { return false }
}
```

**Secret management**: Environment variable `SSO_HMAC_SECRET` (not Vault — avoids runtime dependency risk)

**Key rotation**: Support `SSO_HMAC_SECRET_PREVIOUS` for grace period rotation
1. Set new secret on reverse proxy
2. Update app with both secrets
3. Wait 5 minutes for proxy reload
4. Remove old secret from app
- Rotation period: 90 days

**Reverse proxy ops requirement**: Configure Authentik/Traefik to compute and send `x-authentik-hmac` header

---

### Decision 4: RATE-001 — Distributed Rate Limiting

**Status**: ✅ MOSTLY DONE — code implemented; remaining work is ops

**What exists**: Redis-backed sliding window rate limiter using Lua scripts (atomic, race-condition-free) in `lib/rate-limit-redis.ts` + `middleware.ts`; in-memory fallback if Redis unavailable.

**Per-path limits**:
```typescript
const RATE_LIMITS = {
  '/login': [10, 15 * 60 * 1000],        // 10 req/15min
  '/api/auth': [10, 15 * 60 * 1000],     // 10 req/15min
  '/api/chat': [30, 15 * 60 * 1000],     // 30 req/15min
  '/api/webhooks': [60, 15 * 60 * 1000], // 60 req/15min
  'default': [100, 15 * 60 * 1000],      // 100 req/15min
}
```

**Code fix needed (minor)**: Lua script at lines 106/143 uses `math.random(1000000)` for member uniqueness — high concurrency can cause collisions. Fix: use `now .. ':' .. ARGV[4]` where ARGV[4] is a server-generated UUID/counter.

**HA strategy**: Redis Sentinel (not Cluster) — data is small sorted sets, no sharding needed; Sentinel provides automatic failover with simpler topology. Fail-open (in-memory fallback) is correct — fail-closed would cause outage on Redis failure.

---

### Decision 5: K8S-001 — Pod Log Secret Redaction

**Status**: ✅ COMPLETE — implemented in `fix/k8s-logs-redaction`

**Gap fixed**: `console.error`, `console.warn`, `console.info`, `console.debug` were not wrapped (only `console.log` was). 10-line change in both `apps/web/src/lib/redact.ts` and `apps/gateway/src/lib/redact.ts`.

**Additional patterns added**: PostgreSQL connection strings (`postgres://user:password@host/db`), private keys (`-----BEGIN.*PRIVATE KEY-----`).

**Performance**: Regex matching is microseconds — negligible. False positives in logs are better than leaked secrets.

---

### Decision 6: SQL-001 — SQL Parameterization

**Status**: ✅ ALREADY SAFE — no security work needed

**Findings**: `lib/api-key.ts` uses `$queryRawUnsafe` with positional `$1`/`$2` parameters — Prisma escapes these automatically (safe despite the scary name). `lib/embeddings.ts` uses tagged template literals (Prisma auto-parameterizes). Optional refactor to Prisma ORM would improve maintainability but provides no security benefit.

---

### Decision 7: CSP-001 — Remove `style-src unsafe-inline`

**Approved with caution**: Next.js may genuinely need `unsafe-inline` for inline styles. Audit inline styles first; convert to external stylesheets or CSS modules; test thoroughly before deploying. If removal breaks styles, keep it (functionality > marginal security gain here).

---

### Decision 8: H-004 — Authorization on Notes, AgentGroups, Features

**Notes**: Add `userId` field to `Note` model (Option A — per-user, requires migration). Notes become per-user, not shared.

**AgentGroups**: `requireAdmin()` — agent groups control tool access for agents, this is an admin operation.

**Features/Epics**: Keep `createdBy` as string but populate from `session.user.id` (not body). Add ownership checks for PUT/DELETE.

**Pattern reference**: Follow `apps/web/src/app/api/chatrooms/[id]/route.ts` — uses `getServerSession(authOptions)`, checks `createdBy === userId` for owner-only operations, returns 403 for forbidden.

---

## 2. Completed PRs Reference

### Phase 1 (2026-04-25) — All Merged

| PR | Issue | Files Changed | Change |
|----|-------|-------------|--------|
| #85 | CR-001 | 3 route files | Auth on tool CRUD endpoints |
| #86 | CR-002/003 | 3 route files | Auth on env CRUD + K8s stream/logs |
| #87 | CR-004 | `apps/gateway/src/tool-runner.ts` | SSRF protection (private IPs, cloud metadata, DNS rebinding) |
| #88 | CR-005 | `tools/generate/route.ts` | LLM command sanitization |
| #89 | M-002 | `apps/web/src/lib/auth.ts` | Conditional `__Secure-` cookie prefix |
| #90 | M-003 | `apps/web/src/middleware.ts` | Per-path rate limiting (in-memory) |
| #91 | M-004/005/L-001 | New `apps/web/src/lib/redact.ts`, `schema.prisma` | Log redaction utility + AuditLog DB indexes |
| #92 | H-002/L-002 | `apps/web/src/middleware.ts` | Security headers (CSP nonce-based, X-Frame-Options, HSTS) |
| #96 | H-005/006/M-004 | New `gateway/src/lib/shell-quote.ts`, `gateway/src/lib/redact.ts`, `localhost.ts`, `tool-runner.ts`, `docker-compose.yml` | Shell quoting, package validation, log redaction wiring, `ORION_GATEWAY_TOKEN` env var |
| #98 | M-001 | `lib/api-key.ts` | Parameterized SQL (Prisma ORM) |
| #100 | C-003 | Prisma schema + middleware | Encrypt `gatewayToken`, `kubeconfig`, `apiKey` at write time |
| #102 | C-001 | `worker.ts` | Sanitize llm-context notes before system prompt injection |
| #104 | M-005 | `schema.prisma`, `lib/audit.ts` | Add `ipAddress`/`userAgent` to AuditLog; no writer yet |
| #106 | Input Validation | 3 routes + `lib/validate.ts` | Zod validation on first 3 routes |

---

## 3. Pending Fix Branch Reference

### Phase 2 (2026-04-26) — All Ready to Merge

| Branch | PR | Issue | Key Files | Risk |
|--------|----|-------|-----------|------|
| `fix/gateway-mcp-auth` | #176 | #165 | Gateway MCP routes | LOW |
| `fix/timing-safe-tokens` | #175 | #166 | `middleware.ts:204`, `auth.ts:363` | LOW |
| `fix/k8s-logs-redaction` | #177 | #167 | `redact.ts` (web + gateway) | NONE |
| `fix/db-push-fix` | #178 | #168 | `deploy/entrypoint.sh` | LOW — use `migrate deploy` |
| `fix/argocd-wildcard` | #179 | #169 | ArgoCD AppProject manifest | LOW |
| `fix/input-validation-tier1` | #184 | #170 | 11 routes + `lib/validate.ts` | LOW |
| `fix/docker-limits` | #180 | #171 | `docker-compose.yml` | LOW |
| `fix/mermaid-xss` | #181 | #172 | MermaidBlock component | LOW |
| `fix/sso-hmac` | #182 | #173 | `lib/auth.ts` | LOW |
| `fix/audit-hash-chain` | #183 | #174 | `audit-cleanup.ts` manifest generation | LOW |

### Phase 2 — Not Yet Started

| Branch | Issue | Blocker | Effort |
|--------|-------|---------|--------|
| `fix/secret-redaction-systematic` | #186 | None — `lib/redact.ts` exists | 2-3 days |
| `fix/error-sanitization` | #188 | None | 1-2 days |
| `fix/auth-endpoint-audit` | #189 | None | 1 day |
| `fix/audit-cleanup-automation` | #AUDIT-001 | S3 bucket (ops) | 1-2 days |

---

## 4. Deployment Procedures

### Phase 1 Deployment — 4 Critical Issues

**Target completion**: 2026-05-02 | **Overall risk**: LOW (all backward-compatible)

#### Issue K8S-001: Console Log Redaction Extension
**Risk**: NONE — redaction only, no behavior changes
**Deployment**:
```bash
kubectl set image deployment/orion-web orion-web=ghcr.io/orion/web:<new-tag>
kubectl rollout status deployment/orion-web
```
**Validate**: `docker-compose logs orion | grep -i "REDACTED"` — should appear for secrets in log output.
**Rollback** (1 min): `kubectl set image deployment/orion-web orion-web=ghcr.io/orion/web:previous-tag`

#### Issue INPUT-001: Tier 1 Input Validation (11 routes)
**Risk**: LOW — validation-only, backward compatible (only rejects invalid inputs)
**Validate**:
```bash
# Expect 400
curl -X POST http://localhost:3000/api/tasks -H "Content-Type: application/json" -d '{}'
# Expect 201
curl -X POST http://localhost:3000/api/tasks -H "Content-Type: application/json" \
  -d '{"title": "Valid Task", "priority": "high"}'
```
**Monitor**: 400 response rate on affected routes should be <1% in normal operation.
**Rollback** (5 min): `git revert <commit>; npm run build; npm run deploy`

#### Issue SSO-001: HMAC-SHA256 Validation
**Risk**: MEDIUM (ops dependency) — additive validation, falls back to session auth if proxy not configured
**Ops prerequisites**:
- [ ] Configure Authentik/Traefik to compute HMAC-SHA256 and send `x-authentik-hmac` header
- [ ] Sync HMAC secret between proxy and `SSO_HMAC_SECRET` env var
- [ ] Proxy clock NTP-synchronized (±5 second tolerance)
- [ ] Test in staging first

**Deploy**:
```bash
kubectl set env deployment/orion-web SSO_HMAC_SECRET="<generated-secret>"
kubectl rollout restart deployment/orion-web
```
**Validate**: Auth failures should be <5% if proxy signing is working.
**Rollback** (1 min): `kubectl set env deployment/orion-web SSO_HMAC_SECRET=""`

#### Issue AUDIT-001: S3 Audit Log Export
**Risk**: MEDIUM (new infrastructure) — non-blocking (export runs in background; cleanup gates on success)
**Ops prerequisites**:
- [ ] S3 bucket created with Object Lock enabled (WORM mode)
- [ ] IAM role with write/read/list permissions
- [ ] Bucket versioning enabled
- [ ] Optional: Lifecycle policy (archive to Glacier after 1 year)
- [ ] Optional: Redis Sentinel for lock coordination

**Env vars**:
```
AUDIT_EXPORT_S3_BACKEND=minio  # or aws
AUDIT_EXPORT_S3_ENDPOINT=http://minio:9000
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```
**Validate**: `curl -X POST http://localhost:3000/api/admin/audit-export -H "Authorization: Bearer <token>"` — check MinIO bucket for archive files and manifest.
**Rollback** (5 min): `kubectl set env cronjob/audit-export AUDIT_EXPORT_ENABLED=false`

---

### Phase 2 Deployment — Remaining Issues

**Deployment order** (independent, can be parallelized):
1. K8S-001 → INPUT-001 (no dependencies)
2. SSO-001 (after ops proxy config)
3. AUDIT-001 (after ops S3 setup)

---

## 5. Test Suite

7 SOC2 fixes, 31 test cases. Full test run: ~45-55 minutes.

### Quick Command Reference

```bash
# K8S-001: Check log redaction
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "Test with API Key: orion_ak_abcd1234efgh5678"}'
docker-compose logs orion | grep -i "redact\|orion_ak_"
# Expected: key appears as ***REDACTED***

# INPUT-001: Check validation
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" -d '{}'
# Expected: 400 Bad Request

# SQL-001: Verify parameterized queries
docker-compose exec postgres psql -U orion -d orion -c \
  "ALTER SYSTEM SET log_statement = 'all'; SELECT pg_reload_conf();"
curl -X GET http://localhost:3000/api/agents
docker-compose logs postgres | grep "SELECT.*\$1" | head -1
# Expected: queries use $1/$2 syntax

# RATE-001: Check rate limiting
for i in {1..11}; do
  curl -s -o /dev/null -w "Request $i: %{http_code}\n" http://localhost:3000/api/health
  sleep 0.2
done
# Expected: first 10 return 200, request 11 returns 429

# CSP-001: Check headers
curl -sD /dev/stdout http://localhost:3000 | grep -i "content-security-policy"
# Expected: CSP header present, no "unsafe-inline"

# SSO-001: Check HMAC validation
curl -X POST http://localhost:3000/api/auth/sso \
  -H "X-SSO-User: testuser" -d '{}'
# Expected: 401 (no HMAC)

# AUDIT-001: Check export
curl -X POST http://localhost:3000/api/admin/audit-export \
  -H "Authorization: Bearer <token>"
docker-compose exec minio mc ls local/orion-audit-logs/
# Expected: 200 with jobId, then files appear in bucket
```

### Pass/Fail Criteria

| Fix | Pass | Fail |
|-----|------|------|
| K8S-001 | All secrets show as `***REDACTED***` | Raw secrets appear in logs |
| INPUT-001 | Invalid input → 400, valid → 201 | All requests succeed or wrong status codes |
| SQL-001 | Queries show `$1`, `$2` syntax in logs | String interpolation found |
| RATE-001 | 11th request = 429, `X-RateLimit-*` headers present | Rate limit not enforced |
| CSP-001 | CSP header present, no `unsafe-inline` | `unsafe-inline` present or CSP console violations |
| SSO-001 | Valid HMAC → auth, invalid → 401, missing → 401 | Always rejects or always accepts |
| AUDIT-001 | Export completes, files in S3, manifest has hash chain | Export fails or no files appear |

### Environment Variables Required for Tests

```bash
# Core
NEXTAUTH_SECRET=$(openssl rand -base64 32)
POSTGRES_PASSWORD=<password>

# Redis (RATE-001)
REDIS_URL=redis://redis:6379/0

# SSO (SSO-001)
SSO_HMAC_SECRET=$(openssl rand -hex 32)

# S3/MinIO (AUDIT-001)
AUDIT_EXPORT_S3_BACKEND=minio
AUDIT_EXPORT_S3_ENDPOINT=http://minio:9000
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin
```

### Test Sign-Off Checklist

```markdown
## SOC II Smoke Test Sign-Off
- [ ] All 7 fixes tested
- [ ] Results documented
- [ ] No critical issues remaining
- [ ] All failures have remediation plan
- [ ] Security review completed
- [ ] Ready for production deployment

QA Lead: _____________ Date: _______
Security: _____________ Date: _______
Release Mgr: _____________ Date: _______
```

---

## 6. Remediation Plan — Open Issues

### P0 Critical — Blocking Audit

**INPUT-001: Complete input validation rollout**
- Feature branch: `fix/comprehensive-input-validation`
- Tier 1 in progress (PR #184, 11/20 routes done)
- Remaining routes: 4 ADMIN (POST/PUT users, PUT settings, PUT system-prompts), 2-3 optional (notes, conversations, environments)
- Acceptance criteria: 100% Tier 1 routes validated, 400 on invalid input, error messages don't leak details, no performance regression

**Audit log tamper-proofing (AUDIT-001)**
- Feature branch: `fix/audit-log-retention`
- Acceptance criteria: S3 export job running, manifest with hash chain, Object Lock enabled, cleanup gates on archive success, retention policy documented (12 months minimum)

### P1 High — Merge These PRs

All 10 PRs in `fix/*` branches are code-complete and ready to merge. Merge in this order:
1. #177 (K8S-001 — no deps)
2. #175 (timing-safe — no deps)
3. #176 (MCP auth — no deps)
4. #178 (db push — no deps)
5. #179 (ArgoCD — no deps)
6. #180 (Docker limits — no deps)
7. #181 (Mermaid XSS — no deps)
8. #182 (SSO HMAC — ops dep)
9. #183 (audit hash chain — no deps)
10. #184 (input validation Batch 1 — no deps)

### P1 High — Needs Implementation

**#186 Secret redaction (systematic)**
- Feature branch: `fix/systematic-secret-redaction`
- Gap: `lib/redact.ts` exists with `redactSensitive()`, applied in only 6 of 315 routes
- Acceptance criteria: Applied to all error response paths, all log output, K8s log streams

**#188 Error handling sanitization**
- Feature branch: `fix/error-handling-sanitization`
- Gap: 69 routes catch errors; inconsistent — some re-throw raw SDK errors to clients
- Acceptance criteria: Error messages sanitized before client response; full detail logged server-side

**#189 Authenticate unauthenticated routes**
- Feature branch: `fix/auth-endpoint-verification`
- Gap: 106 routes with no auth checks need classification
- Acceptance criteria: Each of the 106 routes is either marked intentionally-public (with justification) or has `requireAuth()`/`requireAdmin()` added

### P2 Medium — Deferred

| Branch | Issue | Notes |
|--------|-------|-------|
| `fix/p1-mfa-totp` | MFA | Requires `otplib` dep, new API routes, UI changes |
| `fix/p1-rate-limit-redis` | Redis upgrade | Requires Redis infrastructure |
| `fix/p2-audit-retention` | Audit TTL | TTL-based deletion for AuditLog entries |

**JWT rotation policy (L-003)**: No code change — document in `DEPLOYMENT.md`: rotate `NEXTAUTH_SECRET` every 90 days minimum. JWTs from old secret expire naturally.

---

## 7. Post-Fix Compliance Update Procedure

After each fix merges to main:

1. Run `gitnexus_detect_changes()` to confirm scope of changes
2. Update the status column in `SOC2_STATUS.md` for affected findings
3. Run smoke tests for the affected fix (see Section 5)
4. After all Phase 1 PRs merge: re-assess overall compliance percentage

---

*This document consolidates: SOC2_IMPLEMENTATION_GUIDE.md, SOC2_PHASE1_DEPLOYMENT_GUIDE.md, SOC2_PHASE1_COMPLETION_SUMMARY.md, SOC2_REMEDIATION_PLAN.md, SOC2_TEST_INDEX.md, SOC2_OPUS_DECISIONS.md, SOC2_ARCHITECTURE_DECISIONS_FOR_OPUS.md*
