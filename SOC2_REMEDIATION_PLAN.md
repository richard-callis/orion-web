# SOC II Remediation Plan — ORION (2026-04-26)

**Prepared by**: Claude Code SOC II Auditor  
**Date**: 2026-04-26  
**Status**: Ready for Opus Review  
**Target**: SOC II Type II Audit Readiness  

---

## Executive Summary

ORION has made **significant progress** on SOC II compliance (70% complete). Recent work has implemented:
- ✅ Tamper-evidence audit logs via hash chain
- ✅ Comprehensive audit logging (auth, admin, environment events)
- ✅ Encryption at rest for all sensitive secrets
- ✅ LLM prompt injection sanitization
- ✅ MFA/TOTP authentication
- ✅ Session invalidation on password change
- ✅ SSRF protection + command injection prevention

**7 Critical Gaps Remain** that block SOC II Type II audit readiness:

| # | Issue | Priority | Blocker | Est. Effort |
|---|-------|----------|---------|------------|
| 1 | INPUT-001: Comprehensive input validation (Zod) | P0 | YES | 2-3 days |
| 2 | SQL-001: SQL parameterization in api-key.ts | P1 | Investigation | 1 day |
| 3 | AUDIT-001: Audit log retention policy + TTL cleanup | P1 | YES | 1-2 days |
| 4 | SSO-001: SSO header HMAC validation | P1 | NO* | 1-2 days |
| 5 | K8S-001: Pod logs secret redaction | P1 | NO* | 1 day |
| 6 | RATE-001: Distributed rate limiting (Redis) | P1 | NO* | 2-3 days |
| 7 | CSP-001: Remove style-src unsafe-inline | P2 | NO | 0.5 day |

**\*Not blockers for audit, but recommended for production hardening**

---

## Part 1: P0 Critical Gaps (Blocking Audit)

### Issue #1: INPUT-001 — Comprehensive Input Validation (Zod)

#### Status
- **Current**: Only 1 Zod import found in 5700+ symbols
- **Evidence**: Compliance review noted "ZERO input validation library usage"
- **Risk**: CRITICAL — SQL injection, XSS, command injection vectors

#### Root Cause
Per SOC2_COMPLIANCE_REVIEW.md § 1.3:
```typescript
// Example from /api/chat/conversations/route.ts
const body = await req.json().catch(() => ({}))
const convo = await prisma.conversation.create({
  data: { title: body.title ?? null, metadata: ... },
})
// body.title — ANY value, no length limit, no sanitization
```

#### Decision Required: Opus Review

**Question 1: Validation Strategy**
- Option A: Add Zod schema to every route (comprehensive, ~100 routes)
- Option B: Create middleware that validates by endpoint pattern
- Option C: Hybrid (middleware + per-route overrides)

**Question 2: Scope**
- Which routes absolutely need validation? (All, or subset?)
- Should we do full rollout, or phased (critical routes first)?
- What about legacy code that might break?

**Question 3: Documentation**
- Create validation schema registry?
- Document expected request/response shapes?

#### Proposed Implementation (Awaiting Opus Approval)

**Phase 1: Audit + Schema Generation**
1. Scan all API routes in `/api/` directory
2. For each route, extract request body schema from:
   - Prisma model definitions
   - Existing code comments/documentation
   - Usage patterns in handlers
3. Generate Zod schemas for each
4. Create validation middleware or per-route validators

**Phase 2: Deployment**
1. Deploy validation middleware with logging-only mode (no rejection)
2. Monitor logs for validation failures across production
3. Fix edge cases revealed by monitoring
4. Switch to rejection mode
5. Document all validated endpoints

**Phase 3: Compliance Verification**
1. Verify coverage of all public endpoints
2. Test against common attack vectors (SQL injection, XSS, etc.)
3. Document in compliance matrix

#### Acceptance Criteria
- [ ] 100% of API routes have Zod schemas defined
- [ ] Validation rejects invalid input with 400 Bad Request
- [ ] Error messages don't leak implementation details
- [ ] Compliance review updated to reflect validation
- [ ] No performance regression on validated routes
- [ ] Feature branch: `fix/comprehensive-input-validation`

**Estimated Effort**: 2-3 days  
**Blocker**: YES — Cannot pass SOC2 audit without validation

---

### Issue #2: SQL-001 — SQL Parameterization in api-key.ts (M-001)

#### Status
- **Current**: Need to verify if raw SQL has been fully converted
- **Risk**: MEDIUM — SQL injection edge case
- **Evidence**: PR #114 noted but implementation status unclear

#### Root Cause
Per compliance review, `api-key.ts` uses manual quote escaping:
```typescript
const key = apiKey.replace(/'/g, "''")  // Fragile!
```

#### Decision Required: Opus Review

**Question 1: What's the Current State?**
- Has PR #114 fully converted to parameterized queries?
- Are there any remaining raw SQL queries?
- Need code review to confirm.

**Question 2: ORM Strategy**
- Should all queries use Prisma ORM?
- Are there performance reasons to keep raw SQL?

#### Proposed Investigation
1. **Audit api-key.ts**: Search for all SQL operations
2. **Check git history**: Verify PR #114 changes
3. **Test**: Add SQL injection test vectors
4. **Convert**: Replace raw SQL with Prisma ORM if needed

#### Acceptance Criteria
- [ ] No raw SQL queries with manual escaping remain
- [ ] All DB operations use parameterized queries (Prisma ORM)
- [ ] SQL injection tests pass
- [ ] Feature branch: `fix/sql-injection-api-keys` (if changes needed)

**Estimated Effort**: 1 day (investigation + fix)  
**Blocker**: YES — Part of SOC2 data protection requirement

---

## Part 2: P1 High Priority (Production Hardening)

### Issue #3: AUDIT-001 — Audit Log Retention Policy (L-001)

#### Status
- **Current**: No retention policy or cleanup mechanism found
- **Risk**: HIGH — Data minimization liability
- **Problem**: AuditLog table grows unbounded

#### Decision Required: Opus Review

**Question 1: Retention Period**
- SOC2 standard: 12 months minimum
- Should we keep longer (24 months, 7 years)?
- Compliance vs. storage cost trade-off?

**Question 2: Archival Strategy**
- Option A: Delete old logs after retention period
- Option B: Archive to S3/external storage, then delete
- Option C: Separate hot/cold storage tiers

**Question 3: Tamper-Proof Archive**
- How to ensure archive integrity?
- Should we export audit log hash chain?
- How to verify archive has not been modified?

#### Proposed Implementation (Awaiting Opus Approval)

**Phase 1: Policy Definition**
1. Decide retention period (recommend 12 months minimum)
2. Define archival destination (if applicable)
3. Document in compliance matrix

**Phase 2: TTL-Based Cleanup**
1. Add cleanup task to worker process
2. Every 24 hours: delete AuditLog entries older than retention period
3. Log cleanup events to separate audit stream
4. Alert if cleanup fails repeatedly

**Phase 3: Archive Export**
1. Before deletion: export logs to CSV/JSON
2. Include hash chain for verification
3. Store in S3 or external system
4. Document archive location + access controls

#### Acceptance Criteria
- [ ] Retention period defined and documented (min. 12 months)
- [ ] Automated TTL-based cleanup running
- [ ] Archive export mechanism working
- [ ] Cleanup audit events logged separately
- [ ] Feature branch: `fix/audit-log-retention`
- [ ] Compliance matrix updated

**Estimated Effort**: 1-2 days  
**Blocker**: YES — SOC2 compliance requirement

---

### Issue #4: SSO-001 — SSO Header HMAC Validation (Auth Security)

#### Status
- **Current**: Header-based auth trusts reverse proxy without validation
- **Risk**: HIGH — User impersonation if proxy compromised
- **Code**: `apps/web/src/lib/auth.ts` lines 138-166

#### Problem
```typescript
const username = h.get('x-authentik-username') ?? h.get('x-forwarded-user')
const user = await prisma.user.upsert({
  where: { username },
  create: { username, email: ..., role: 'user', provider: 'authentik' },
})
```

If reverse proxy is compromised (e.g., Traefik vuln), attacker can set any username header.

#### Decision Required: Opus Review

**Question 1: HMAC Secret Management**
- Where to store HMAC secret?
  - Option A: Environment variable (simple, but shared)
  - Option B: Vault secret (secure, adds dependency)
  - Option C: Per-header signature in reverse proxy config
- How to rotate HMAC secret without breaking existing sessions?

**Question 2: Deployment Coordination**
- Reverse proxy must sign headers with HMAC
- Requires infrastructure changes (Traefik/nginx config)
- How to coordinate deployment with ops?

**Question 3: Backward Compatibility**
- What about existing sessions created without HMAC?
- Grace period for unsigned headers?

#### Proposed Implementation (Awaiting Opus Approval)

**Phase 1: HMAC Validation Logic**
1. Add `validateHeaderHMAC(headers: Headers, secret: string): boolean`
2. Verify HMAC signature on `x-authentik-username` header
3. Reject if signature invalid or missing
4. Log failed auth attempts with IP/UA

**Phase 2: Infrastructure Coordination**
1. Document HMAC signing in reverse proxy config
2. Require reverse proxy to compute `HMAC-SHA256(secret, username)`
3. Send as `x-authentik-username-hmac` header
4. Coordinate rollout with ops

**Phase 3: Testing**
1. Test with valid HMAC signatures
2. Test rejection of invalid/missing HMAC
3. Monitor logs for false rejections
4. Verify no legitimate users blocked

#### Acceptance Criteria
- [ ] HMAC validation implemented in auth.ts
- [ ] Reverse proxy config updated to sign headers
- [ ] Failed auth attempts logged
- [ ] Rate limiting applied to SSO endpoint (already in #130)
- [ ] Documentation updated
- [ ] Feature branch: `fix/sso-header-hmac-validation`

**Estimated Effort**: 1-2 days (code + ops coordination)  
**Blocker**: NO (but recommended for production)

---

### Issue #5: K8S-001 — Pod Logs Secret Redaction

#### Status
- **Current**: /api/k8s/stream returns raw pod logs without redaction
- **Risk**: MEDIUM — Credentials exposed via pod logs
- **Code**: `apps/web/src/app/api/k8s/stream/route.ts`

#### Problem
Pod logs may contain:
- API keys (`orion_ak_*`, etc.)
- Bearer tokens
- Database credentials
- Webhook secrets
- External API credentials

#### Decision Required: Opus Review

**Question 1: Secrets to Redact**
- Should we use existing redaction patterns from `redact.ts`?
- Are there additional patterns specific to K8s?
- How to avoid over-redacting (e.g., example IPs)?

**Question 2: Redaction Method**
- Regex-based pattern matching?
- Token/key detection heuristics?
- Lookup against known secret patterns?

**Question 3: Performance**
- How many pods/logs typical in a deployment?
- Will redaction regex cause performance issues?
- Should redaction be optional/configurable?

#### Proposed Implementation (Awaiting Opus Approval)

**Phase 1: Redaction Patterns**
1. Reuse existing patterns from `lib/redact.ts`
2. Add K8s-specific patterns (token secrets, etc.)
3. Document all patterns

**Phase 2: Integration**
1. Apply redaction in `startWatchers()` before broadcasting logs
2. Apply redaction in `/api/k8s/stream` response
3. Ensure no raw logs leak to frontend

**Phase 3: Testing**
1. Test with pods containing known secrets
2. Verify redaction coverage
3. Performance test under load
4. Ensure no false positives (over-redaction)

#### Acceptance Criteria
- [ ] All common secret patterns redacted
- [ ] Redaction integrated into K8s log endpoints
- [ ] Performance test shows < 5% overhead
- [ ] Feature branch: `fix/k8s-logs-secret-redaction`

**Estimated Effort**: 1 day  
**Blocker**: NO (but recommended for production)

---

### Issue #6: RATE-001 — Distributed Rate Limiting (Redis)

#### Status
- **Current**: In-memory Map rate limiter
- **Risk**: MEDIUM — Cannot scale beyond single instance
- **Blocker**: Multi-replica deployments
- **Code**: `apps/web/src/lib/rate-limit.ts`

#### Problem
```typescript
const limiter = new Map<string, { count: number; resetAt: number }>()
// ☝️ Per-instance state — not shared across replicas
```

#### Decision Required: Opus Review

**Question 1: Storage Backend**
- Option A: Redis (most common, requires new dependency)
- Option B: Memcached (simpler, but less feature-rich)
- Option C: Cloudflare Durable Objects (cloud-specific)
- Recommendation: **Redis** (industry standard)

**Question 2: Deployment**
- Redis cluster or single instance?
- High availability requirements?
- Fallback behavior if Redis unavailable?

**Question 3: Implementation**
- Should we replace existing limiter, or add Redis-backed option?
- How to migrate existing in-memory limits?

#### Proposed Implementation (Awaiting Opus Approval)

**Phase 1: Redis Integration**
1. Add `redis` or `ioredis` dependency
2. Implement `RedisRateLimiter` class
3. Keep existing `InMemoryRateLimiter` for fallback

**Phase 2: Migration**
1. Use Redis limiter in production, in-memory in dev
2. Test failover behavior (Redis down → fallback to in-memory)
3. Monitor Redis connection/latency

**Phase 3: Scaling**
1. Verify rate limits work across multiple replicas
2. Test under load
3. Performance profile

#### Acceptance Criteria
- [ ] Redis rate limiter implemented
- [ ] Fallback to in-memory if Redis unavailable
- [ ] Multi-replica rate limiting working
- [ ] Performance test shows no degradation
- [ ] Feature branch: `fix/distributed-rate-limiting`

**Estimated Effort**: 2-3 days  
**Blocker**: NO (but required for multi-instance deployments)

---

### Issue #7: CSP-001 — Remove style-src unsafe-inline

#### Status
- **Current**: CSP contains `style-src 'unsafe-inline'`
- **Risk**: LOW — XSS attack surface widened
- **Code**: `apps/web/src/middleware.ts`

#### Problem
`unsafe-inline` allows arbitrary `<style>` tags, weakening XSS protection.

#### Decision Required: Opus Review

**Question 1: Current Inline Styles**
- How many inline `<style>` tags in codebase?
- Are they in React components or static HTML?
- Can they be moved to external stylesheets or CSS-in-JS?

**Question 2: Alternative Approaches**
- Option A: External stylesheets only (most secure)
- Option B: CSS-in-JS with nonce
- Option C: Keep unsafe-inline for now (not recommended)

#### Proposed Implementation (Awaiting Opus Approval)

**Phase 1: Audit**
1. Find all inline `<style>` tags
2. Extract styles to separate files
3. Update imports/references

**Phase 2: CSP Update**
1. Remove `'unsafe-inline'` from `style-src`
2. Add nonce to any remaining inline styles (if necessary)
3. Verify all styles load correctly

**Phase 3: Testing**
1. Render all pages without `unsafe-inline`
2. Verify styling is correct
3. Test in all browsers

#### Acceptance Criteria
- [ ] No inline `<style>` tags with content
- [ ] All styles in external stylesheets or CSS modules
- [ ] CSP updated to remove `unsafe-inline`
- [ ] All pages render correctly
- [ ] Feature branch: `fix/csp-hardening`

**Estimated Effort**: 0.5 day  
**Blocker**: NO (low priority security hardening)

---

## Part 3: Implementation Sequence

### Phase 1: Immediate (Blocking Audit)
1. **INPUT-001** (2-3 days) — Zod validation framework
2. **SQL-001** (1 day) — Verify/fix SQL parameterization
3. **AUDIT-001** (1-2 days) — Audit log retention

**Total**: 4-6 days  
**Outcome**: Ready for SOC2 Type II audit

### Phase 2: Production Hardening (Recommended)
4. **SSO-001** (1-2 days) — HMAC validation
5. **K8S-001** (1 day) — Log redaction
6. **RATE-001** (2-3 days) — Distributed rate limiting

**Total**: 4-6 days  
**Outcome**: Production-ready security posture

### Phase 3: Minor Improvements
7. **CSP-001** (0.5 day) — CSP hardening

---

## Part 4: Decision Matrix for Opus Review

| Issue | Decision Needed | Options | Recommendation |
|-------|-----------------|---------|-----------------|
| INPUT-001 | Validation strategy | A: Per-route Zod | A (comprehensive) |
| INPUT-001 | Rollout scope | Full/phased/critical-first | Phased (critical first) |
| AUDIT-001 | Retention period | 12/24/36 months | 12 months (SOC2 min) |
| AUDIT-001 | Archival | Delete/S3/cold-storage | S3 archival |
| SSO-001 | HMAC secret location | Env/Vault/proxy-config | Vault secret |
| K8S-001 | Redaction patterns | Regex/heuristic/lookup | Regex (existing patterns) |
| RATE-001 | Storage backend | Redis/Memcached/Durable-Objects | Redis |
| RATE-001 | High availability | Single/cluster/failover | Cluster with fallback |
| CSP-001 | Approach | External/CSS-in-JS/nonce | External + CSS modules |

---

## Part 5: Risk Assessment

### Technical Risks
1. **INPUT-001**: Large refactoring → potential regressions
   - **Mitigation**: Phased rollout, comprehensive testing, monitoring
2. **RATE-001**: Redis dependency → new infrastructure requirement
   - **Mitigation**: Fallback to in-memory, gradual rollout
3. **SSO-001**: HMAC validation → coordinate with ops
   - **Mitigation**: Grace period, careful staging

### Compliance Risks
1. **INPUT-001**: Blocking audit without validation → CRITICAL
2. **AUDIT-001**: No retention policy → compliance violation
3. **SQL-001**: Raw SQL → injection vulnerability

---

## Part 6: Success Criteria

✅ **Audit Readiness**:
- All 7 issues investigated and prioritized
- P0 issues (INPUT-001, SQL-001, AUDIT-001) have concrete implementation plans
- P1 issues have architectural decisions from Opus
- Compliance matrix updated post-fixes

✅ **Security Posture**:
- No input validation gaps
- No SQL injection vectors
- Audit logs retained per policy
- Header auth protected with HMAC
- K8s logs redacted
- Rate limiting distributed

✅ **Documentation**:
- Each issue has feature branch + PR
- Compliance matrix reflects new fixes
- Security decisions documented

---

## Next Steps

1. **Opus Review**: Submit Part 4 (Decision Matrix) to Opus for architectural approval
2. **Feature Branches**: Create worktrees for each issue:
   - `fix/comprehensive-input-validation`
   - `fix/sql-injection-api-keys`
   - `fix/audit-log-retention`
   - `fix/sso-header-hmac-validation`
   - `fix/k8s-logs-secret-redaction`
   - `fix/distributed-rate-limiting`
   - `fix/csp-hardening`
3. **Implementation**: After Opus approval, implement in Phase order
4. **Verification**: Run `gitnexus_detect_changes()` before each commit
5. **Compliance Update**: Update SOC2_COMPLIANCE_REVIEW.md post-fix

---

## Appendix: References

- `/opt/orion/SOC2_COMPLIANCE_REVIEW.md` — Full compliance audit (2026-04-25)
- `/opt/orion/CLAUDE.md` — GitNexus instructions
- GitHub Issues: INPUT-001, SQL-001, AUDIT-001, SSO-001, K8S-001, RATE-001, CSP-001
- Recent Merges: PR #137, #135, #126, #125, #120, #116, #115, #102

---

**Document Status**: Ready for Opus Review  
**Prepared by**: Claude Code Auditor  
**Date**: 2026-04-26
