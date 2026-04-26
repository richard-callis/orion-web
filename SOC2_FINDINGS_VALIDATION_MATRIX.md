# SOC II Audit Findings — Validation Against GitHub Issues
**Date**: 2026-04-26  
**Purpose**: Cross-reference independent audit findings with existing GitHub issues  

---

## Validation Matrix

### 🔴 CRITICAL Findings

| Finding | Severity | GitHub Issue | Status | Gap Analysis |
|---------|----------|---|--------|---|
| **Gateway MCP endpoints unauthenticated** | CRITICAL | #165 | ✅ TRACKED | Issue #165 correctly identifies CRITICAL auth bypass in `/mcp`, `/mcp/message`. |
| **Input validation coverage (69% gap)** | CRITICAL | #170 | ✅ TRACKED | Issue #170 correctly identifies only ~15% of routes use Zod validation. Our audit found 69% lack explicit validation (108 routes, 74 unvalidated). |
| **Rate limiting absent** | CRITICAL | ❌ NOT TRACKED | ⚠️ **NEW** | No rate limiting anywhere in codebase. Needs new issue: `RATE-LIMIT-001` |
| **Secret redaction inadequate** | CRITICAL | #167 | ⚠️ PARTIALLY | Issue #167 focuses on K8s logs specifically. Our audit found 315 routes access secrets, only 6 redact. Needs broader issue: `SECRET-EXPOSURE-001` |

---

### 🟠 HIGH Priority Findings

| Finding | Severity | GitHub Issue | Status | Gap Analysis |
|---------|----------|---|--------|---|
| **Kubernetes pod logs leak secrets** | HIGH | #167 | ✅ TRACKED | Correctly identified. K8s log endpoints lack redaction. |
| **Timing attack on token comparison** | HIGH | #166 | ✅ TRACKED | Correctly identified in middleware.ts:204 and auth.ts:363. Uses `===` instead of `timingSafeEqual()`. |
| **No resource limits on Docker** | HIGH | #171 | ✅ TRACKED | Correctly identified. docker-compose.yml missing resource limits. |
| **MermaidBlock XSS vulnerability** | HIGH | #172 | ✅ TRACKED | SVG rendering with innerHTML allows XSS via `securityLevel: 'loose'`. |
| **db push --accept-data-loss risk** | HIGH | #168 | ✅ TRACKED | Critical data destruction risk in entrypoint.sh. |
| **Security headers inadequate** | HIGH | ❌ NOT TRACKED | ⚠️ **NEW** | Only 4 places setting security headers. No CORS policy. No CSRF tokens. Needs new issue: `SECURITY-HEADERS-001` |
| **Error handling information disclosure** | HIGH | ❌ NOT TRACKED | ⚠️ **NEW** | Inconsistent error handling, may leak implementation details. Needs new issue: `ERROR-HANDLING-001` |

---

### 🟡 MEDIUM Priority Findings

| Finding | Severity | GitHub Issue | Status | Gap Analysis |
|---------|----------|---|--------|---|
| **ArgoCD AppProject wildcard permissions** | MEDIUM | #169 | ✅ TRACKED | Correctly identified. Needs source repo, destination, and resource restrictions. |
| **SSO HMAC validation bypass** | MEDIUM | #173 | ✅ TRACKED | HMAC validation silently passes when `SSO_HMAC_SECRET` not set. |
| **Audit export hash chain broken** | MEDIUM | #174 | ✅ TRACKED | Manifest hash computed before field is populated. Integrity verification broken. |
| **Audit logging not automated** | MEDIUM | ⚠️ PARTIAL #AUDIT-001 | ⚠️ PARTIAL | Cleanup script exists (`audit-cleanup.ts`) but NOT integrated into worker. Must be scheduled manually via cron. |
| **Authentication bypass surface** | MEDIUM | ❌ PARTIAL | ⚠️ INVESTIGATION NEEDED | 106 routes with NO auth checks. Need to verify which are intentionally public vs. oversight. |

---

## Summary of Validation Results

### ✅ Issues Already Tracked (9 issues)

1. **#165** — Gateway MCP endpoints unauthenticated (CRITICAL)
2. **#170** — Input validation coverage gap (MEDIUM)
3. **#167** — K8s logs leak secrets (HIGH)
4. **#166** — Timing attack on token comparison (HIGH)
5. **#171** — No Docker resource limits (HIGH)
6. **#172** — MermaidBlock XSS (HIGH)
7. **#168** — db push data loss (HIGH)
8. **#169** — ArgoCD wildcard permissions (MEDIUM)
9. **#173** — SSO HMAC bypass (MEDIUM)
10. **#174** — Audit hash chain broken (MEDIUM)

### ⚠️ Issues PARTIALLY Tracked (1 issue)

**#AUDIT-001** — Audit log retention policy
- **Status**: Script exists (`audit-cleanup.ts`) but NOT auto-running
- **Gap**: Must be triggered by cron job or worker — not guaranteed
- **Action**: Integrate cleanup into worker process or ensure cron is configured

### ❌ NEW Issues NOT Tracked (4 issues)

1. **RATE-LIMIT-001** — Zero rate limiting in entire codebase
   - 0 endpoints protected
   - No distributed rate limiting (Redis/Memcached)
   - Severity: CRITICAL

2. **SECRET-EXPOSURE-001** — Systematic secret redaction gap
   - 315 routes access secrets, only 6 use redaction
   - Broader than just K8s logs (#167)
   - Severity: CRITICAL

3. **SECURITY-HEADERS-001** — Missing security headers middleware
   - Only 4 places setting headers
   - No CORS policy defined
   - No CSRF token checks
   - Severity: HIGH

4. **ERROR-HANDLING-001** — Information disclosure via error messages
   - Inconsistent error handling
   - May leak implementation details to attackers
   - Severity: HIGH

5. **AUTH-BYPASS-001** — Verify 106 unauthenticated routes
   - Need to classify which are intentionally public
   - Some may be admin endpoints without protection
   - Severity: MEDIUM (investigation required)

---

## Comparison Summary

| Category | Count | Status |
|----------|-------|--------|
| **Tracked Issues** | 10 | ✅ Validated |
| **Partial Issues** | 1 | ⚠️ Needs completion |
| **New Issues** | 5 | ❌ Need creation |
| **Total Compliance Gaps** | **16** | |

---

## Next Steps

### Phase 1: Create New GitHub Issues
Create 5 new issues for gaps not currently tracked:
- [ ] RATE-LIMIT-001 — Rate limiting implementation (CRITICAL)
- [ ] SECRET-EXPOSURE-001 — Systematic secret redaction (CRITICAL)
- [ ] SECURITY-HEADERS-001 — Security headers middleware (HIGH)
- [ ] ERROR-HANDLING-001 — Error message sanitization (HIGH)
- [ ] AUTH-BYPASS-001 — Verify public endpoint list (MEDIUM)

### Phase 2: Fix Partial Issue
- [ ] #AUDIT-001 — Integrate cleanup into worker process (HIGH)

### Phase 3: Create Feature Branches
One worktree per GitHub issue. Coordinate with Opus on architectural decisions.

### Phase 4: Review Open PRs
Check if any of these issues are already being fixed in flight.

---

**Prepared By**: Claude Code Auditor (Fresh Eyes)  
**Validation Date**: 2026-04-26  
**Status**: Ready for Issue Creation Phase
