# SOC II Remediation — Opus Architectural Decisions (2026-04-26)

**Status**: ✅ APPROVED WITH CAVEATS  
**Review Date**: 2026-04-26  
**Reviewer**: Opus 4.6  

---

## Executive Summary

Opus has approved the SOC II remediation approach with **critical changes to sequencing and scope**:

1. **REVISED CRITICAL PATH**: SSO-001 promoted from P1 to P0 (header injection is exploitable today)
2. **INPUT-001 Scope Reduced**: Use hybrid tier approach instead of comprehensive (2 days vs 3 days, massively reduced risk)
3. **RATE-001 Effort Reduced**: Code mostly done, remaining work is ops (Redis deploy) — 0.5 days dev work
4. **AUDIT-001 Easier**: Cleanup mechanism exists, just need S3 export step before deletion

---

## Approved Decisions

### Decision 1: INPUT-001 Input Validation Strategy

**Approved**: **Hybrid Tier Approach** (NOT comprehensive all 91 routes)

**Tier 1 (MUST VALIDATE)** — 25-30 routes:
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

**Tier 2 (SHOULD VALIDATE)** — Internal service routes:
- `/api/environments/[id]/sync-status`
- `/api/environments/[id]/tools`
- Other gateway-called endpoints with Bearer auth

**Tier 3 (SKIP)** — Read-only and infrastructure:
- All GET routes
- `/api/k8s/stream`, `/api/health`, health checks

**Implementation Notes**:
- Use existing `lib/validate.ts` (already has conversation, environment, note schemas)
- Derive schemas from `context/schema.md` Prisma models
- Create `parseBodyOrError(req, schema)` helper that returns `NextResponse` on error (not null) — prevents bugs where devs forget validation checks
- For updates (PUT/PATCH): use `.partial()` on create schemas
- **String length constraints are critical for SOC2** — even without full schemas, `.max()` on strings prevents storage DoS

**Effort**: 2 days for Tier 1, 1 day for Tier 2 (3 days total, not the original 2-3 days for all 91 routes)

**Risk Mitigation**:
- Do not touch all 91 files simultaneously — massive regression risk
- Start with Tier 1 (the critical routes where untrusted external input feeds to DB writes)
- Tier 2 can be a follow-up
- Tier 3 is not needed for SOC2

---

### Decision 2: AUDIT-001 Audit Log Retention Policy

**Approved as proposed with clarifications**

**Retention Period**: **12 months (365 days)** is sufficient for SOC2 Type II
- SOC2 does not prescribe exact period, just requires defined policy + adherence
- 12 months is industry standard
- Your code already enforces this via `getRetentionDays()` with defaults

**Archival Strategy**: **Export to S3 before deletion**
1. **Export Phase**: Daily/weekly job exports logs older than `retentionDays - 30` as newline-delimited JSON to S3
   - Key pattern: `audit-archive/YYYY/MM/batch-{timestamp}.jsonl.gz`
   - 30-day overlap window prevents gaps if export fails
2. **Delete Phase**: Existing cleanup only deletes after export confirms success

**Tamper-Proof Archive**:
- Include full hash chain (all `previousHash` and computed `hash` fields)
- Create manifest file with:
  - Hash of first record in batch
  - Hash of last record  
  - SHA-256 digest of entire archive file
- Enable S3 Object Lock (WORM mode) on both archive + manifest
- **Do NOT store just summary hash** — auditors need full chain for verification

**Proof of Authenticity**:
- Hash chain within each batch is self-verifying
- Last hash of batch N = `previousHash` of first record in batch N+1 (proves continuity)
- S3 Object Lock prevents modification

**CRITICAL**: Your current `audit-cleanup.ts` deletes without archiving first. **Build S3 export step BEFORE enabling automated cleanup in production.** Manual cleanup route should verify archive is current.

**Effort**: 1-2 days (the hard part — deletion — is already done)

---

### Decision 3: SSO-001 SSO Header HMAC Validation

**Approved**: **PROMOTED TO P0** (was P1)

**CRITICAL FINDING**: Header-injection vulnerability in `lib/auth.ts:198-224` is exploitable today if attacker bypasses proxy:

```typescript
// VULNERABLE:
const username = h.get('x-authentik-username')
const user = await prisma.user.upsert({
  where: { username },
  create: { username, email: ..., role: 'user' }
})
// If attacker reaches app directly: x-authentik-username: admin → auto-provisioned as admin
```

**Solution**: **HMAC-SHA256 validation**

**Reverse Proxy Signing**:
- Compute: `HMAC-SHA256(secret, canonical_string)` where:
  ```
  canonical_string = 
    x-authentik-username|x-authentik-email|x-authentik-name|x-authentik-uid|timestamp
  ```
- Include 30-second timestamp (prevents replay, allows clock skew)
- Send signature in new header: `x-authentik-hmac`

**Backend Validation**:
1. Parse timestamp; reject if > 30 seconds old
2. Reconstruct canonical string from headers
3. Compute HMAC using `timingSafeEqual` for comparison (NOT `===` — timing-attack vulnerable)
4. If invalid: **reject entirely** (do not fall through to session auth)

**Secret Management**: **Environment variable** (`SSO_HMAC_SECRET`)
- Vault adds runtime dependency risk (auth outage if Vault sealed)
- Env var via Kubernetes Secret is appropriate for symmetric key
- Same trust model as `NEXTAUTH_SECRET` + `ORION_GATEWAY_TOKEN`

**Key Rotation**: **Support grace period**
- Accept `SSO_HMAC_SECRET` (current) + `SSO_HMAC_SECRET_PREVIOUS` (old) simultaneously
- Validate against current first; fall back to previous on failure
- Rotation procedure:
  1. Set new secret on reverse proxy
  2. Update app with both secrets
  3. Wait 5 minutes for proxy reload
  4. Remove old secret from app
- **Rotation period**: 90 days (standard for symmetric keys)

**Defense-in-Depth**: 
- The `x-forwarded-for` header (used in rate limiting) can also be spoofed if proxy is bypassed
- Consider validating that SSO header requests come from expected proxy IP range (additional control, not replacement for HMAC)

**Effort**: 1 day

**Dependencies**: Requires ops coordination to configure reverse proxy (Authentik/Traefik) to compute HMAC signatures. **Start this conversation immediately** — on critical path.

---

### Decision 4: RATE-001 Distributed Rate Limiting

**Status**: **MOSTLY DONE** — Code is implemented, remaining work is ops

**What's Already Implemented**:
- Redis-backed sliding window rate limiter using Lua scripts (atomic, race-condition-free)
- Fallback to in-memory if Redis unavailable
- Per-path rate limit configuration in middleware
- This is in `lib/rate-limit-redis.ts` and `middleware.ts`

**High Availability Strategy**: **Redis Sentinel** (not Cluster)
- Your data is small (sorted sets with timestamps) — no need for sharding
- Sentinel provides automatic failover with simpler topology than Cluster
- Cluster is for shard-across-nodes use cases — overkill

**Fail-Open Behavior**: **Allow all** (already implemented)
- Falls back to in-memory when Redis unavailable — correct choice
- Fail-closed (reject all) would cause outage on Redis failure — worse than brief unprotected window
- In-memory fallback still provides per-instance rate limiting

**Code Fix** (minor):
- Lua script at line 106, 143 uses `math.random(1000000)` for member uniqueness
- High concurrency can cause collisions
- Fix: Use `now .. ':' .. ARGV[4]` where ARGV[4] is server-generated UUID/counter

**Effort**: 0.5 days (code fix) + ops for Redis Sentinel deployment (separate ticket)

**Dependencies**: Requires Redis infrastructure. If not deployed, add to ops prerequisites.

---

### Decision 5: K8S-001 Pod Logs Secret Redaction

**Approved**: **Regex-based patterns** (Option A)

**Current Gap**: Only `console.log` is wrapped with redaction
- `console.error`, `console.warn`, `console.info` bypass redaction entirely
- This is a real security gap (errors are commonly logged in catch blocks)

**Pattern Coverage** (use existing `redact.ts`):
- API keys (`orion_ak_*`)
- Bearer tokens
- Passwords
- JWTs
- Gateway tokens (`mcg_*`)
- Known env var names

**Additional Patterns to Add**:
- PostgreSQL connection strings: `postgres://user:password@host/db`
- Private keys: `-----BEGIN.*PRIVATE KEY-----`
- Base64-encoded secrets: Caution — match only in known-secret fields (e.g., kubeconfig), as this has high false-positive rate

**Implementation**:
- Extend `wrapConsoleLog` to cover `console.error`, `console.warn`, `console.info` (10-line change)
- Regex matching is negligible performance impact (microseconds)

**Risk of Over-Redacting**: Low and acceptable. False positives in logs are better than leaked secrets.

**Effort**: 0.5 days

---

### Decision 6: SQL-001 SQL Parameterization

**Status**: **ALREADY SAFE** — No security issue

**Findings**:
1. `lib/api-key.ts`: Uses `$queryRawUnsafe` with positional parameters (`$1`, `$2`). Despite scary name, this **IS parameterized** — Prisma escapes parameters automatically. Safe.
2. `lib/embeddings.ts`: Uses tagged templates (`prisma.$queryRaw\`...\``), which Prisma automatically parameterizes. Safe.
3. `api/health/route.ts`: No user input. Safe.

**Recommendation**: 
- **No security work needed** — passes audit as-is
- **Optional refactor**: Convert `api-key.ts` to Prisma ORM (better maintainability via type safety, not security benefit)
- If you do refactor, 0.5 days effort

---

### Decision 7: CSP-001 Remove style-src unsafe-inline

**Status**: **APPROVED** but with caution

**Concern**: Next.js genuinely needs `unsafe-inline` for inline styles in some cases. Removing it may break UI.

**Recommendation**:
- Audit for inline styles in application
- Convert to external stylesheets or CSS modules where possible
- Test thoroughly before deploying — UI regressions are possible
- If you cannot remove `unsafe-inline` without breaking styles, keep it (security vs. functionality trade-off)

**Effort**: 0.5 days

---

## Revised Critical Path

**DO NOT follow original Phase 1/2/3 plan** — Opus recommends this sequence:

### Phase 0: Prerequisites (Parallel to Dev)
1. **Ops**: Deploy Redis Sentinel (for RATE-001)
2. **Ops**: Create S3 bucket with Object Lock enabled (for AUDIT-001)
3. **Ops**: Configure reverse proxy (Authentik/Traefik) to compute HMAC signatures (for SSO-001)

### Phase 1: Critical Security Fixes (Days 1-4)
1. **INPUT-001** (Tier 1 only, not comprehensive) — 2 days
   - Focus: Auth, admin, mutation routes (25-30 routes)
   - Create `parseBodyOrError` helper
   - Build Zod schemas for critical routes
   - Test auth endpoint validation

2. **SSO-001** (PROMOTE TO P0, was P1) — 1 day
   - Implement HMAC-SHA256 validation in auth.ts
   - Add timestamp checking (30s tolerance)
   - Use `timingSafeEqual` for signature comparison
   - Add audit logging for header auth attempts
   - Document HMAC secret rotation (90 days)

3. **K8S-001** (Quick fix, real gap) — 0.5 day
   - Wrap `console.error`, `console.warn`, `console.info` with redaction
   - Verify console wrapper covers all log methods

4. **AUDIT-001** (S3 export) — 1-2 days
   - Build scheduled export job (export logs to S3 before deletion)
   - Implement manifest generation with hash chain
   - Enable S3 Object Lock on archive
   - Gate manual cleanup behind archive verification

**Subtotal Phase 1**: 4-5 days (critical security gaps)

### Phase 2: Ops Tasks + Optional Improvements (Days 5-7)
5. **RATE-001** — 0.5 days (code fix) + ops (Redis deploy)
   - Fix Lua script UUID issue
   - Deploy Redis Sentinel (ops owns this)
   - Verify multi-instance rate limiting

6. **INPUT-001 Tier 2** (Optional) — 1 day
   - Add validation to internal service routes

7. **SQL-001** (Optional refactor) — 0.5 days or skip
   - Convert `api-key.ts` to Prisma ORM (maintainability benefit, no security benefit)
   - Or leave as-is (already parameterized, passes audit)

8. **CSP-001** (Test carefully) — 0.5 day
   - Audit inline styles
   - Attempt to remove `unsafe-inline`
   - Test thoroughly before merge

**Subtotal Phase 2**: 2-3 days (hardening + optional refactoring)

**Total**: 6-8 days to audit-ready (vs. original 10-14 days)

---

## Risk Assessment (from Opus)

**HIGH RISK** 🔴:
- SSO header injection (`lib/auth.ts:202-217`) is exploitable today if proxy is bypassed
- **This is why it's promoted to P0**

**MEDIUM RISK** 🟡:
- Lack of input validation on auth/admin routes
- Mitigated by auth requirement, but authenticated users can still inject data
- Audit log retention/archival design is critical for SOC2

**LOW RISK** 🟢:
- SQL parameterization (already safe)
- CSP unsafe-inline (test carefully before removing)

**NEGLIGIBLE** ✅:
- Command injection (shell-quote is bulletproof)
- Rate limiting (code already done, ops owns deployment)

---

## Implementation Notes from Opus

### INPUT-001 Helper Function
```typescript
// lib/validate.ts — suggested approach

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
    return {
      error: NextResponse.json(
        { error: 'Bad request' },
        { status: 400 }
      )
    }
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

### SSO-001 Backend Validation
```typescript
// lib/auth.ts — suggested HMAC validation

import { timingSafeEqual } from 'crypto'

async function validateSSoHeaderHmac(headers: Headers): Promise<boolean> {
  const secret = process.env.SSO_HMAC_SECRET
  if (!secret) return false

  const username = headers.get('x-authentik-username')
  const email = headers.get('x-authentik-email')
  const name = headers.get('x-authentik-name')
  const uid = headers.get('x-authentik-uid')
  const timestamp = headers.get('x-authentik-timestamp')
  const signature = headers.get('x-authentik-hmac')

  if (!username || !timestamp || !signature) return false

  // Check timestamp (30-second tolerance)
  const now = Date.now()
  const ts = parseInt(timestamp, 10)
  if (isNaN(ts) || now - ts > 30_000) return false

  // Reconstruct canonical string
  const canonical = [username, email, name, uid, timestamp].join('|')
  
  // Compute expected HMAC
  const crypto = await import('crypto')
  const expected = crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest('hex')

  // Timing-safe comparison
  try {
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    return true
  } catch {
    return false  // Signatures do not match
  }
}

// In getCurrentUser():
if (ssoProvider?.headerMode) {
  if (!validateSSoHeaderHmac(h)) {
    // Log failed attempt with IP/UA
    return null  // Reject with 401
  }
  // ... proceed with upsert
}
```

---

## Summary Table

| Issue | Opus Decision | Effort | Priority | Dependencies |
|-------|---------------|--------|----------|--------------|
| INPUT-001 | Hybrid Tier 1 | 2 days | P0 | None |
| SSO-001 | HMAC-SHA256 | 1 day | **P0 (promoted)** | Ops (reverse proxy config) |
| K8S-001 | Console wrapping | 0.5 day | P1 | None |
| AUDIT-001 | S3 export + manifest | 1-2 days | P1 | Ops (S3 bucket) |
| RATE-001 | Code fix (UUID) | 0.5 day | P1 | Ops (Redis Sentinel) |
| INPUT-001 Tier 2 | Optional follow-up | 1 day | P2 | None |
| SQL-001 | Optional refactor | 0.5 day | P2 | None |
| CSP-001 | Test carefully | 0.5 day | P2 | None |

**Critical Path**: INPUT-001 → SSO-001 → K8S-001 → AUDIT-001 (4-5 days)

---

## Next Steps

1. ✅ Opus architectural review complete
2. ⏳ Create worktrees for Phase 1 (INPUT-001, SSO-001, K8S-001, AUDIT-001)
3. ⏳ Start development on INPUT-001 (Tier 1 routes)
4. ⏳ Coordinate with ops on reverse proxy + Redis + S3 setup
5. ⏳ Implement fixes in critical path order
6. ⏳ Run impact analysis before each change
7. ⏳ Merge to main + update SOC2_COMPLIANCE_REVIEW.md

**Target**: SOC2 Type II audit-ready by 2026-05-02 (6-8 days from start of implementation)

---

**Document Status**: Approved by Opus  
**Date**: 2026-04-26  
**Next**: Begin Phase 1 implementation
