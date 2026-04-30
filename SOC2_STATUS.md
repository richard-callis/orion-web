# SOC2 Compliance Status — ORION

**Last Updated**: 2026-04-26
**Scope**: ORION management plane (`/opt/orion`)
**Framework**: SOC 2 Type II — Trust Service Criteria
**Overall Maturity**: ~75-80% compliant (as of 2026-04-26, corrected after middleware audit)

---

## Executive Summary

ORION has solid foundational security: bcrypt password hashing (cost 14), nonce-based CSP headers, Redis-backed rate limiting, SSRF protection, shell-quote escaping, and AES-256-GCM encryption. However, critical gaps in input validation, systematic secret redaction, and audit log completeness block SOC 2 Type II certification.

**Good news discovered during correction audit**: Rate limiting and security headers are already implemented at the middleware layer — initial per-route audit missed these. Compliance was revised upward from ~65% to ~75-80%.

---

## 1. Findings Summary

### CRITICAL — Audit Blockers

| ID | Finding | File | Status |
|----|---------|------|--------|
| C1 | **Setup wizard hardcoded `'fallback-secret'`** — forged wizard JWT possible if `NEXTAUTH_SECRET` not set | `apps/web/src/lib/setup-guard.ts:8` | ❌ OPEN |
| C2 | **Gitea admin credentials exposed** via unauthenticated `/api/setup/bootstrap-config` | `apps/web/src/app/api/setup/bootstrap-config/route.ts:18-20` | ❌ OPEN |
| C3 | **Input validation: 69% of POST/PUT/PATCH routes lack explicit validation** — 74 of 108 routes parse JSON without Zod/schema | Multiple routes | ⏳ IN PROGRESS (#170) |
| C4 | **Audit logs not tamper-proof** — no hash chain, no WORM storage, no external shipping; admins can delete via `POST /api/admin/audit-retention/cleanup` | `src/lib/audit.ts` | ⏳ PARTIAL (#174) |

### HIGH — Production Hardening Required

| ID | Finding | Status |
|----|---------|--------|
| H1 | **Gateway token grants near-complete admin access** — no RBAC check on `/api/admin/*` | ⏳ #165 (PR #176 ready) |
| H2 | **SSO header auth accepts spoofable `x-forwarded-user`** — no HMAC verification, no IP allowlist | ⏳ #173 (PR #182 ready) |
| H3 | **No session invalidation on password change** — JWT valid up to 30 days after reset | ❌ OPEN |
| H4 | **Middleware session cookie name mismatch** — hardcoded `'next-auth.session-token'` but production uses `'__Secure-next-auth.session-token'` | `apps/web/src/middleware.ts:183` | ❌ OPEN |
| H5 | **Encryption key rotation broken** — `/api/internal/encryption/rotate` creates chicken-and-egg problem | ❌ OPEN |
| H6 | **Internal Docker network is plaintext HTTP** — Vault, ORION, and PostgreSQL connections without TLS | ❌ OPEN |
| H7 | **`kubectl_apply_url` bypasses SSRF protection** — user URL passed directly to `kubectl apply -f <url>` | `apps/gateway/src/builtin-tools/kubernetes.ts:172-186` | ❌ OPEN |
| H8 | **`docker_exec` accepts arbitrary commands** — no allowlist, passed to `sh -c` | `apps/gateway/src/builtin-tools/docker.ts:71-84` | ⏳ #171 (PR #180 ready) |
| H9 | **K8s log credential exposure** — pod logs may contain plaintext secrets, redaction not applied to stream/log endpoints | ⏳ #167 (PR #177 ready) |
| H10 | **`db push --accept-data-loss` in entrypoint.sh** — production data destruction risk | `deploy/entrypoint.sh` | ⏳ #168 (PR #178 ready) |
| H11 | **Timing attack on token comparison** — `===` used instead of `timingSafeEqual` | `apps/web/src/middleware.ts:204`, `auth.ts:363` | ⏳ #166 (PR #175 ready) |
| H12 | **MermaidBlock XSS** — SVG rendering uses `innerHTML` with `securityLevel: 'loose'` | ⏳ #172 (PR #181 ready) |
| H13 | **Audit events missing** — login, MFA enable/disable/verify, admin mutations, env lifecycle not logged; `logAudit()` silently swallows errors | `src/lib/audit.ts:49-72` | ⏳ PARTIAL |
| H14 | **No graceful shutdown** — worker exits with `process.exit(1)` on fatal errors | ❌ OPEN |
| H15 | **LLM prompt injection** — `llm-context` notes injected verbatim into agent system prompts, no sanitization | `worker.ts:53-62` | ✅ FIXED (PR #102) |

### MEDIUM

| ID | Finding | Status |
|----|---------|--------|
| M1 | **Secret redaction gap** — 315 routes access secrets, only 6 use `redactSensitive()` | ⏳ #186 (partial — library exists) |
| M2 | **`ExternalModel.apiKey` stored in plaintext** in DB | ✅ FIXED (PR #100) |
| M3 | **`Environment.kubeconfig` stored in plaintext** | ✅ FIXED (PR #100) |
| M4 | **`Environment.gatewayToken` stored in plaintext** (schema comment says "hashed") | ✅ FIXED (PR #100) |
| M5 | No MFA/TOTP support — single-factor only | ⏳ Planning branch `fix/p1-mfa-totp` |
| M6 | No password complexity requirements (only 10-char minimum) | ❌ OPEN |
| M7 | Session `maxAge` 30 days with no idle timeout | ❌ OPEN |
| M8 | No concurrent session limits | ❌ OPEN |
| M9 | Audit log cleanup deletable at any time (no archive gate) | ⏳ `fix/p2-audit-retention` |
| M10 | Audit log page shows only last 100 entries — no filtering, no IP/UA display | ❌ OPEN |
| M11 | Gemini API key passed as URL query parameter (may appear in access logs) | ❌ OPEN |
| M12 | No namespace isolation in Kubernetes client — service account has cluster-wide read | ❌ OPEN |
| M13 | **ArgoCD AppProject wildcard permissions** — needs source/destination/resource restrictions | ⏳ #169 (PR #179 ready) |
| M14 | **SSO HMAC validation passes when `SSO_HMAC_SECRET` not set** | ⏳ #173 (PR #182 ready) |
| M15 | **Audit export hash chain broken** — manifest hash computed before field populated | ⏳ #174 (PR #183 ready) |
| M16 | Audit log cleanup not automated — `audit-cleanup.ts` exists but requires manual cron | ⏳ #AUDIT-001 |
| M17 | Error messages may leak implementation details to clients | ⏳ #188 not started |
| M18 | 106 unauthenticated routes need classification — which are intentionally public? | ⏳ #189 not started |
| M19 | `file_read` tool lacks path traversal validation | ❌ OPEN |
| M20 | No request body size limits | ❌ OPEN |

---

## 2. SOC 2 Trust Service Criteria Mapping

| Criterion | Status | Key Evidence / Gaps |
|-----------|--------|---------------------|
| **CC6.1 Logical Access** | ⚠️ PARTIAL | RBAC exists (admin/user/readonly); no middleware-level enforcement |
| **CC6.2 Authentication** | ✅ MOSTLY | bcrypt cost 14, JWT, `__Secure-` cookie, CSRF via NextAuth — gaps: no MFA, SSO header trust |
| **CC6.3 Role-Based Access** | ⚠️ PARTIAL | Tier-based tool access; admin routes rely on per-handler `requireAdmin()` calls |
| **CC6.5 Boundary Protection** | ✅ COMPLIANT | SSRF blocking in `tool-runner.ts` (private IPs, DNS rebinding) |
| **CC6.6 System Failure / Rate Limiting** | ✅ COMPLIANT | Redis-backed rate limiting with per-path limits; in-memory fallback |
| **CC6.7 Data Injection** | ✅ COMPLIANT | Shell-quote escaping (`quote()`), package name regex; gaps: `kubectl_apply_url`, `docker_exec` |
| **CC6.8 Authorized Software** | ✅ COMPLIANT | Package validation `^[a-zA-Z][a-zA-Z0-9._+-]*$` (max 127 chars) |
| **CC7.1 Monitoring / Audit** | ⚠️ PARTIAL | AuditLog model + indexes exist; only 3 of 37 action types called; no tamper-proof storage |
| **C1 Encryption** | ⚠️ PARTIAL | AES-256-GCM for SystemSetting; sensitive DB fields now encrypted (PRs #98/#100); no key rotation strategy |
| **C1 Input Validation** | ❌ NON-COMPLIANT | ~31% coverage; 74 routes unvalidated |
| **C1 Data Protection** | ⚠️ PARTIAL | Application-level encryption; PII (email, name, username) in plaintext in User/AuditLog |
| **C6 Availability** | ⚠️ PARTIAL | Gateway heartbeats, worker concurrency control; no graceful shutdown, no circuit breakers |

---

## 3. Compliance Progression

| Audit Date | Assessment | Notes |
|------------|-----------|-------|
| 2026-04-25 (initial) | ~70% compliant | First SOC2 review; 25 findings identified |
| 2026-04-25 (after PRs) | ~70-75% | PRs #85-#92, #96 merged; 19 of 25 findings addressed |
| 2026-04-26 (fresh audit, initial) | ~65% | Independent re-audit; found rate limiting and headers missed |
| 2026-04-26 (corrected) | **~75-80%** | Middleware-level rate limiting and security headers confirmed; compliance revised upward |

---

## 4. All GitHub Issues — Status Register

### Phase 1: Initial Audit (2026-04-25) — Issues #67-#83

| PR / Branch | Issue | What it Does | Status |
|-------------|-------|-------------|--------|
| PR #85 | CR-001 (#68) | Auth on all tool CRUD endpoints | ✅ Merged |
| PR #86 | CR-002/CR-003 (#69-#70) | Auth on env CRUD + K8s stream/logs | ✅ Merged |
| PR #87 | CR-004 (#71) | SSRF protection in gateway | ✅ Merged |
| PR #88 | CR-005 (#72) | LLM tool injection sanitization | ✅ Merged |
| PR #89 | M-002 (#80) | Conditional cookie secure flag | ✅ Merged |
| PR #90 | M-003 (#81) | Per-path rate limiting (in-memory) | ✅ Merged |
| PR #91 | M-004/M-005/L-001 (#82-#83) | Log redaction utility + AuditLog DB indexes | ✅ Merged |
| PR #92 | H-002/L-002 | Security headers (CSP, X-Frame-Options, HSTS) | ✅ Merged |
| PR #96 | H-005/H-006/M-004 | Shell quoting, package validation, log redaction | ✅ Merged |
| PR #98 | M-001 (#97) | SQL parameterized queries in api-key.ts | ✅ Done |
| PR #100 | C-003 (#99) | Encrypt sensitive DB fields | ✅ Done |
| PR #102 | C-001 (#101) | Sanitize llm-context prompt injection | ✅ Done |
| PR #104 | M-005 (#103) | Enrich audit logs with IP/UA fields | ✅ Done |
| PR #106 | Input Validation (#105) | Zod validation on first 3 routes | ✅ Done |

### Phase 2: Second Audit (2026-04-26) — Issues #165-#189

| PR | Issue | Title | Severity | Status |
|----|-------|-------|----------|--------|
| PR #176 | #165 | Gateway MCP auth bypass | CRITICAL | ⏳ Ready for review |
| PR #175 | #166 | Timing-safe token comparison | HIGH | ⏳ Ready for review |
| PR #177 | #167 | K8s log redaction | HIGH | ⏳ Ready for review |
| PR #178 | #168 | db push data loss fix | HIGH | ⏳ Ready for review |
| PR #179 | #169 | ArgoCD wildcard permissions | MEDIUM | ⏳ Ready for review |
| PR #184 | #170 | Input validation (Batch 1 of 5-6) | CRITICAL | ⏳ Ready for review |
| PR #180 | #171 | Docker resource limits | HIGH | ⏳ Ready for review |
| PR #181 | #172 | Mermaid XSS hardening | HIGH | ⏳ Ready for review |
| PR #182 | #173 | SSO HMAC bypass fix | MEDIUM | ⏳ Ready for review |
| PR #183 | #174 | Audit hash chain repair | MEDIUM | ⏳ Ready for review |
| — | #185 | Rate limiting | CRITICAL | ✅ ALREADY DONE (middleware) |
| — | #186 | Systematic secret redaction | CRITICAL | ⏳ Library exists, not applied broadly |
| — | #187 | Security headers | HIGH | ✅ ALREADY DONE (middleware) |
| — | #188 | Error handling sanitization | HIGH | ❌ Not started |
| — | #189 | Verify unauthenticated routes | MEDIUM | ❌ Not started |
| — | #AUDIT-001 | Audit log cleanup automation | MEDIUM | ⏳ Script exists, not integrated |

### Planning-Only Branches (No Code Yet)

| Branch | Issue | Priority |
|--------|-------|----------|
| `fix/p1-mfa-totp` | MFA/TOTP | P1 |
| `fix/p1-rate-limit-redis` | Rate limit Redis upgrade | P1 |
| `fix/p1-ss-header-auth` | SSO HMAC (infra side) | P1 |
| `fix/p1-k8s-logs-redaction` | K8s log redaction | P1 |
| `fix/p2-audit-retention` | Audit log TTL | P2 |

---

## 5. Findings Validation Matrix — Fresh Audit vs. Prior Tracking

| Finding | Prior Tracking | Fresh Audit | Resolution |
|---------|---------------|-------------|------------|
| Gateway MCP auth bypass | #165 ✅ | CONFIRMED CRITICAL | PR #176 |
| Input validation 69% gap | #170 ✅ | CONFIRMED CRITICAL | PR #184 + batches |
| Rate limiting absent | ❌ Not tracked | FOUND then CORRECTED — already in middleware | #185 closed |
| Secret redaction gap | #167 (K8s only) | Broadened — 315 routes, only 6 redact | #186 new issue |
| K8s pod log secrets | #167 ✅ | CONFIRMED HIGH | PR #177 |
| Timing attack tokens | #166 ✅ | CONFIRMED HIGH | PR #175 |
| Docker resource limits | #171 ✅ | CONFIRMED HIGH | PR #180 |
| MermaidBlock XSS | #172 ✅ | CONFIRMED HIGH | PR #181 |
| db push data loss | #168 ✅ | CONFIRMED HIGH | PR #178 |
| Security headers missing | ❌ Not tracked | FOUND then CORRECTED — already in middleware | #187 closed |
| Error handling disclosure | ❌ Not tracked | NEW HIGH | #188 |
| ArgoCD wildcard | #169 ✅ | CONFIRMED MEDIUM | PR #179 |
| SSO HMAC bypass | #173 ✅ | CONFIRMED MEDIUM | PR #182 |
| Audit hash chain | #174 ✅ | CONFIRMED MEDIUM | PR #183 |
| Unauth routes audit | ❌ Not tracked | NEW MEDIUM (investigation) | #189 |
| Audit cleanup automation | #AUDIT-001 ⚠️ PARTIAL | CONFIRMED — script not integrated | In progress |

**Why fresh audit initially overcounted gaps**: Grep search scoped to `apps/web/src/app/api` excluded the middleware layer where rate limiting and security headers operate globally.

---

## 6. Path to Audit Readiness

### Blocking (Must Fix Before SOC 2 Audit)

1. **#170 Input validation** — Complete Batches 2-5 (admin, API, remaining routes). ~31% → 80%+ coverage needed.
2. **#186 Secret redaction** — Apply `redactSensitive()` to error paths, logs, K8s stream. ~6% → systematic coverage.
3. **#165 Gateway MCP auth** — Merge PR #176.
4. **#168 db push fix** — Merge PR #178.
5. **C1/C2 Wizard/bootstrap auth** — Fallback secret removal, auth gate on `bootstrap-config`.

### High Priority (Merge These PRs)

6. PR #175 — Timing-safe tokens (#166)
7. PR #177 — K8s log redaction (#167)
8. PR #179 — ArgoCD (#169)
9. PR #180 — Docker limits (#171)
10. PR #181 — Mermaid XSS (#172)
11. PR #182 — SSO HMAC (#173)
12. PR #183 — Audit hash chain (#174)
13. PR #184 — Input validation Batch 1 (#170)

### Medium Priority

14. Implement #188 error sanitization
15. Classify #189 unauthenticated routes
16. Automate #AUDIT-001 cleanup

### Estimated Timeline

| Phase | Duration | Outcome |
|-------|----------|---------|
| Merge 10 in-flight PRs | 1-2 days | Remove 10 tracked issues |
| Input validation batches 2-5 | 4-6 days | Audit-blocking gap closed |
| Secret redaction rollout | 2-3 days | CRITICAL gap closed |
| #188, #189, #AUDIT-001 | 3-4 days | Remaining gaps closed |
| **Total to audit-ready** | **2-3 weeks** | **SOC 2 Type II audit-ready** |

---

## 7. What Is Already Compliant

The following controls pass a SOC 2 audit today:

- **Password hashing**: bcryptjs cost 14 (exceeds OWASP minimum of 12)
- **Session security**: `__Secure-` cookie prefix, `httpOnly: true`, CSRF via NextAuth
- **API key hashing**: `orion_ak_` prefix + bcrypt hashing
- **Security headers** (middleware): CSP with nonce (no `unsafe-inline`), X-Frame-Options: DENY, HSTS with preload, Permissions-Policy, Referrer-Policy
- **Rate limiting** (middleware): Per-path Redis-backed limits (10 req/15min auth, 30 req/15min chat); in-memory fallback
- **SSRF protection**: Private/reserved IP blocking, DNS rebinding prevention, scheme validation
- **Shell injection prevention**: `shell-quote.ts` `quote()` function, 127-char package name limit with strict regex
- **Command injection prevention**: Dangerous pattern blocklist + metacharacter check
- **Log redaction**: `wrapConsoleLog()` in both web and gateway — wraps `console.log/error/warn/info/debug`
- **Encryption at rest**: AES-256-GCM for SystemSetting; `gatewayToken`, `kubeconfig`, `apiKey` encrypted in DB (PR #100)
- **Audit log model**: `AuditLog` with `userId`, `action`, `target`, `detail`, `ipAddress`, `userAgent`, `createdAt`; indexed on userId + createdAt
- **Prompt injection sanitization**: `llm-context` notes sanitized before system prompt injection (PR #102)
- **SQL parameterization**: Prisma ORM used throughout; `api-key.ts` uses positional `$1`/`$2` params (safe despite name `$queryRawUnsafe`)
- **CORS/CSRF**: NextAuth built-in CSRF protection; `next-auth.csrf-token` cookie
- **Encryption in transit**: TLS via reverse proxy, HSTS with preload; Vault proxy uses 4096-bit TLS

---

*This document consolidates: SOC2_AUDIT_REPORT.md, SOC2_FRESH_AUDIT_SUMMARY.md, SOC2_INDEPENDENT_AUDIT_REPORT.md, SOC2_AUDIT_CORRECTION.md, SOC2_COMPLIANCE_REVIEW.md, SOC2_IMPLEMENTATION_STATUS.md, SOC2_FINAL_STATUS_2026_04_26.md, SOC2_FINDINGS_VALIDATION_MATRIX.md*
