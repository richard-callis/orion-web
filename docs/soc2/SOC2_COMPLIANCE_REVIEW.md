# SOC 2 Compliance Review — ORION Application

**Scope**: ORION management plane (`/opt/orion`)
**Date**: 2026-04-25
**Framework**: AICAA SOC 2 Type II — Trust Service Criteria

---

## Executive Summary

ORION has **foundational security controls in place** but has **significant gaps** that would block a SOC 2 Type II audit. Authentication is robust (bcrypt cost 14, JWT with per-request DB validation, proper cookie security), and command injection prevention is strong (shell-quote escaping, SSRF validation). However, the following critical issues must be addressed:

| Severity | Count | Key Issues |
|----------|-------|------------|
| **HIGH** | 4 | No input validation, LLM prompt injection, SSO header trust, sensitive data encryption gaps |
| **MEDIUM** | 6 | SQL injection fragility, rate limiter not distributed, audit log retention, error handling inconsistency, Vault token exposure, CSP weakening |
| **LOW** | 4 | No MFA, no helmet dependency, inconsistent error patterns, magic strings |

---

## 1. Security (SRR.R1 — Security)

### 1.1 Authentication ([M-002]) — **PARTIALLY COMPLIANT**

**Strengths:**
- bcryptjs cost factor 14 for password hashing (exceeds OWASP minimum of 12)
- NextAuth.js JWT strategy with per-request DB validation on every callback
- `__Secure-` cookie prefix in production (enforces HTTPS)
- `httpOnly: true` on session and CSRF cookies
- API key authentication with `orion_ak_` prefix + bcrypt hashing
- CSRF protection via NextAuth built-in mechanism
- Service token auth for gateway-to-ORION communication

**Gaps:**
- **No MFA/TOTP support** — single-factor only
- **SSO header-based auth** (`auth.ts:138-166`) uses `x-authentik-username` header with auto-user-upsert. If the reverse proxy is compromised or misconfigured, an attacker can impersonate any user:
  ```typescript
  const username = h.get('x-authentik-username') ?? h.get('x-forwarded-user')
  const user = await prisma.user.upsert({
    where: { username },
    create: { username, email: ..., role: 'user', provider: 'authentik' },
  })
  ```
  No rate limiting on header-based auth. No email verification. No account enumeration protection.
- **Gateway tokens stored as plaintext** in `Environment.gatewayToken` (schema comment says "hashed" but it's stored as Bearer token)
- Session `sameSite: 'lax'` — could be `'strict'` for tighter security

### 1.2 Authorization ([CR-001]) — **PARTIALLY COMPLIANT**

**Strengths:**
- Role-based access control: `admin`, `user`, `readonly`
- Tier-based access: `viewer` < `operator` < `admin`
- Tool group access via `ToolGroup.minimumTier`
- Agent group-to-tool-group mapping
- Per-tool agent restrictions
- Tool approval workflow with `ToolApprovalRequest` and `ToolExecutionGrant`
- Admin-only route patterns (`/admin/*`, `/api/agent-groups/*`, `/api/admin/*`)
- Service auth routes for internal API access

**Gaps:**
- **No middleware-level authorization** — routes rely on per-handler calls to `getCurrentUser()`, `requireAdmin()`, etc. A forgotten call = unprotected route.
- No route-level RBAC enforcement at the framework level

### 1.3 Input Validation — **NON-COMPLIANT**

**Finding: ZERO input validation library usage across the entire codebase.**

```typescript
// /api/chat/conversations/route.ts — no validation
const body = await req.json().catch(() => ({}))
const convo = await prisma.conversation.create({
  data: { title: body.title ?? null, metadata: ... },
})
```

- `body.title` can be any arbitrary value — no length limit, no sanitization
- No Zod, Joi, Yup, or similar library imported anywhere
- Architecture review confirms: "No request validation"

### 1.4 API Security ([H-002], [L-002]) — **MOSTLY COMPLIANT**

**Strengths:**
- Comprehensive security headers configured in `middleware.ts`:
  - CSP: `default-src 'self'; script-src 'self' 'strict-dynamic'`
  - X-Frame-Options: DENY
  - X-Content-Type-Options: nosniff
  - HSTS with preload (production)
  - Permissions-Policy blocking camera, microphone, geolocation, payment
- SSRF protection in `tool-runner.ts:14-86` — blocks private/reserved IP ranges, DNS rebinding, `javascript:`/`data:`/`file:` schemes
- Log redaction for secrets (`redact.ts` — masks API keys, tokens, passwords)

**Gaps:**
- `style-src 'unsafe-inline'` weakens CSP
- `connect-src 'self' https:` is permissive for all HTTPS origins
- No `helmet` dependency (security headers manually implemented)

### 1.5 Rate Limiting ([M-003]) — **PARTIALLY COMPLIANT**

**Strengths:**
- Per-path rate limiting before auth check
- Auth endpoints limited to 10 req/15min
- Tool generation limited to 20 req/15min

**Gaps:**
- **In-memory `Map`** — not distributed across replicas
- No sliding window
- Cleanup only triggers every 100 requests per key

### 1.6 Command Injection Prevention ([H-005], [H-006]) — **COMPLIANT**

**Strengths:**
- `shell-quote.ts` with proper single-quote escaping (`'` escaped as `'\''`)
- Architecture review: "This is bulletproof"
- Package name validation with strict regex: `^[a-zA-Z][a-zA-Z0-9._+-]*$`
- 127-char max on package names

---

## 2. Availability (A-001)

### 2.1 Processing Integrity — **PARTIALLY COMPLIANT**

**Strengths:**
- Gateway heartbeats every 30s to ORION
- Worker polls DB every 15s, max 3 concurrent tasks
- Watcher agents run every 60s
- Graceful SIGTERM handling

**Gaps:**
- No error recovery in GitOps loop (orphaned branches)
- Gateway heartbeat doesn't detect stale state (hang detection missing)
- No circuit breaker pattern for external API calls
- Inconsistent error handling across API routes — some have zero try/catch

---

## 3. Confidentiality (C-001)

### 3.1 Encryption at Rest ([C-003]) — **NON-COMPLIANT**

**Strengths:**
- AES-256-GCM encryption for `SystemSetting` values
- Key rotation support via `encryptWithKey`/`decryptWithKey`
- Backward compatible with plaintext values

**Critical Gaps:**
- **`ExternalModel.apiKey` stored as plaintext** in database — no encryption marker, no schema-level protection
- **`Environment.kubeconfig` stored as plaintext** — may contain cluster secrets
- **`Environment.gatewayToken` stored as plaintext** (despite schema comment saying "hashed")
- Encryption middleware (`encryption-middleware.ts`) lists `gatewayToken` and `kubeconfig` in `ENCRYPTED_ENV_FIELDS` but the schema-level evidence of protection is absent
- `ORION_ENCRYPTION_KEY` from env var with no key rotation automation

### 3.2 LLM Prompt Injection ([C-001]) — **NON-COMPLIANT**

**Critical finding** — `llm-context` notes are injected verbatim into every agent's system prompt:

```typescript
// worker.ts:53-62
const wikiContext = contextNotes.length > 0
  ? `\n\n---\n## Knowledge Base\n\n` +
    contextNotes.map(n => `### ${n.title}\n${n.content}`).join('\n\n')
  : ''
const systemPrompt = agentSystemPrompt + wikiContext
```

No sanitization, no escaping, no validation. A user could inject prompt injection attacks (jailbreaks, system overrides) through the Note editor. This is a direct confidentiality risk for AI-driven operations.

### 3.3 Encryption in Transit — **COMPLIANT**

- TLS via reverse proxy with HSTS
- Vault proxy uses self-signed 4096-bit TLS certs
- HSTS with preload in production

### 3.4 Sensitive Data Redaction ([M-004]) — **COMPLIANT**

- Dual redaction in both web and gateway (wraps `console.log`)
- Detects: `orion_ak_` API keys, Bearer tokens, gateway join tokens (`mcg_<hex>`), setup tokens, known env var names
- Preserves first 4 + last 4 chars for log readability

---

## 4. Audit & Logging (M-005, L-001)

### 4.1 AuditLog Model — **PARTIALLY COMPLIANT**

**Strengths:**
- `AuditLog` model with `userId`, `action`, `target`, `detail` (JSON), `createdAt`
- Indexed on `userId` and `createdAt` for SOC 2 queries
- Admin endpoint: `GET /api/admin/audit-log`

**Gaps:**
- **No retention policy** — unbounded growth, no TTL, no archival
- **No `ipAddress` field** — cannot correlate audit events to source IPs
- **No `userAgent` field** — cannot detect anomalous access patterns
- Audit logs never deleted — could become a liability under data minimization principles

---

## 5. Database Security — **PARTIALLY COMPLIANT**

**Strengths:**
- Prisma ORM provides parameterized queries (prevents SQL injection in Prisma queries)
- API key queries use parameterized `$1`, `$2` placeholders

**Gaps:**
- **Raw SQL in `api-key.ts`** uses manual single-quote escaping (`'`.replace(`'`, `''`)) for `updateLastUsed` and `deleteByKey` — fragile against edge cases (Unicode quotes, etc.)
- No row-level security
- No field-level encryption for most sensitive fields at the database level

---

## 6. Privacy (P-001) — **MINIMAL ASSESSMENT**

**Data collected:** Username, email, name, provider, externalId, role, lastSeen
**Retention:** Conversations soft-deleted via `archivedAt` (max 50), messages cascade-delete
**External sharing:** LLM API calls to Claude, Ollama, Gemini, OpenAI; git provider webhooks

**Gaps:**
- No data export or deletion mechanism for users
- No privacy policy or terms of service documented
- No consent mechanism

---

## 7. SOC 2 Compliance Matrix

| Trust Service Criterion | Status | Evidence |
|------------------------|--------|----------|
| **[M-002] Authentication** | ⚠️ PARTIAL | Strong hashing + JWT, but no MFA, header auth trust |
| **[M-003] Rate Limiting** | ⚠️ PARTIAL | Per-path limits, but in-memory only |
| **[M-004] Data Redaction** | ✅ COMPLIANT | Comprehensive log redaction |
| **[M-005] Audit Logging** | ⚠️ PARTIAL | Model exists, but no IP/UA fields, no retention |
| **[CR-001] Authorization** | ⚠️ PARTIAL | RBAC exists, but no middleware enforcement |
| **[CR-003] K8s Secret Exposure** | ❌ NON-COMPLIANT | Pod logs may leak secrets, no redaction on K8s access |
| **[CR-004] SSRF Protection** | ✅ COMPLIANT | IP blocking + DNS rebinding protection |
| **[CR-005] Tool Auth Required** | ✅ COMPLIANT | Tool generation requires auth |
| **[H-002] API Security** | ✅ MOSTLY COMPLIANT | Good headers, minor CSP weakening |
| **[H-005] Command Injection** | ✅ COMPLIANT | Bulletproof shell-quote escaping |
| **[H-006] Package Validation** | ✅ COMPLIANT | Strict regex + length limit |
| **[C-001] Confidentiality** | ❌ NON-COMPLIANT | Prompt injection via llm-context notes |
| **[C-003] Encryption at Rest** | ❌ NON-COMPLIANT | API keys, kubeconfig, gateway tokens in plaintext |
| **[L-001] Audit Retention** | ❌ NON-COMPLIANT | No retention policy on AuditLog |
| **[A-001] Availability** | ⚠️ PARTIAL | Heartbeats + concurrency control, no error recovery |

---

## 8. Remediation Priority

### P0 — Must Fix Before Audit
1. **Encrypt `ExternalModel.apiKey` and `Environment.kubeconfig`** at rest using the existing `encryption.ts` module
2. **Sanitize `llm-context` note content** before injection into system prompts (strip system-level instructions, use a separator, validate against known-safe patterns)
3. **Add `ipAddress` and `userAgent` fields** to `AuditLog` model
4. **Add input validation** — add Zod as a dependency and validate all API route inputs

### P1 — High Priority
5. **Add MFA/TOTP support** for admin accounts
6. **Implement audit log retention** — TTL-based deletion or archival after 12 months
7. **Migrate rate limiter to Redis** (or at minimum document as single-instance limitation)
8. **Protect SSO header auth** — add HMAC signature validation on header proxy
9. **Add redaction to K8s pod logs** endpoint — mask secrets/tokens before returning to user

### P2 — Medium Priority
10. Fix raw SQL in `api-key.ts` to use parameterized queries
11. Tighten CSP — remove `unsafe-inline` from style-src
12. Add error handling middleware for all API routes
13. Add session revocation/blacklist mechanism
14. Implement key rotation for `ORION_ENCRYPTION_KEY`

### P3 — Low Priority
15. Add `helmet` dependency to replace manual security headers
16. Change `sameSite: 'lax'` to `'strict'`
17. Add kubeconfig preflight validation
18. Fix duplicate `startWatchers()` call in K8s stream route

---

## 9. Overall Assessment

**Current Maturity: SOC 2 Type I — Partially Ready**

ORION has solid foundational security (strong password hashing, SSRF protection, command injection prevention, good security headers) but has critical gaps in data encryption at rest, input validation, and prompt injection prevention that would need significant remediation before a Type II audit could succeed.

The most actionable immediate wins are:
1. Encrypt sensitive DB fields using existing encryption middleware
2. Add prompt injection safeguards for llm-context notes
3. Add Zod validation to API routes
4. Enrich audit logs with IP/user-agent fields

---

## 10. Remediation Status (Updated 2026-04-25)

### Existing SOC2 Branches (Already Merged or Noted)

| Finding | Existing Branch | Status | Notes |
|---------|----------------|--------|-------|
| CR-004 SSRF | `fix/cr-004-ssrf-gateway` | ✅ Merged | IP blocking + DNS rebinding protection |
| CR-005 LLM Tool Injection | `fix/cr-005-llm-tool-injection` | ✅ Merged | Keyword filter + command allowlist |
| H-001 Encryption | `fix/h-001-encrypt-secrets` | ✅ Merged | Key rotation + SystemSetting encryption |
| H-003 Path Traversal | `fix/h-003-path-traversal` | ✅ Merged | DNS domain validation |
| H-004 Authorization | `fix/h-004-authorization` | ✅ Merged | Auth on unprotected routes |
| H-005/006 Command Injection | `fix/h-005-006-m-004` | ✅ Merged | Shell-quote + package validation |
| L-002 Security Headers | `fix/l-002-security-headers` | ✅ Merged | Security headers middleware |
| M-002 Cookies | `fix/m-002-003-cookies-rate` | ✅ Merged | Conditional secure flag |
| M-003 Rate Limiting | `fix/m-003-rate-limiting` | ✅ Merged | Per-path limits (in-memory) |
| M-004/005 Audit Logs | `fix/m-004-005-logs-audit` | ✅ Merged | Redaction utility + indexes |
| M-001 SQL Injection | `fix/m-001-sql-injection` | ❌ Based on old main | Replaced by new branch below |

### New Branches Created in This Session

| # | Finding | Branch | PR | Issue | Status |
|---|---------|--------|----|-------|--------|
| 1 | M-001 SQL Injection | `fix/m-001-sql-injection-api-keys` | [#98](https://github.com/richard-callis/orion-web/pull/98) | [#97](https://github.com/richard-callis/orion-web/issues/97) | ✅ Done |
| 2 | C-003 Encryption at Rest | `fix/c-003-encrypt-sensitive-fields` | [#100](https://github.com/richard-callis/orion-web/pull/100) | [#99](https://github.com/richard-callis/orion-web/issues/99) | ✅ Done |
| 3 | C-001 Prompt Injection | `fix/c-001-sanitize-llm-context` | [#102](https://github.com/richard-callis/orion-web/pull/102) | [#101](https://github.com/richard-callis/orion-web/issues/101) | ✅ Done |
| 4 | M-005 Enrich Audit | `fix/m-005-enrich-audit-logs` | [#104](https://github.com/richard-callis/orion-web/pull/104) | [#103](https://github.com/richard-callis/orion-web/issues/103) | ✅ Done |
| 5 | Input Validation | `fix/input-validation` | [#106](https://github.com/richard-callis/orion-web/pull/106) | [#105](https://github.com/richard-callis/orion-web/issues/105) | ✅ Done |

### Deferred Branches (Planning Only — No Code Yet)

| # | Finding | Branch | PR | Issue | Priority | Notes |
|---|---------|--------|----|-------|----------|-------|
| 6 | MFA/TOTP | `fix/p1-mfa-totp` | [#109](https://github.com/richard-callis/orion-web/pull/109) | — | P1 | Requires `otplib` dep, new API routes, UI changes |
| 7 | Rate Limit Redis | `fix/p1-rate-limit-redis` | [#110](https://github.com/richard-callis/orion-web/pull/110) | — | P1 | Requires Redis infrastructure |
| 8 | SSO Header Auth | `fix/p1-ss-header-auth` | [#111](https://github.com/richard-callis/orion-web/pull/111) | — | P1 | Requires infra changes (HMAC secret) |
| 9 | K8s Logs Redaction | `fix/p1-k8s-logs-redaction` | [#112](https://github.com/richard-callis/orion-web/pull/112) | — | P1 | Mask secrets in pod logs endpoint |
| 10 | Audit Retention | `fix/p2-audit-retention` | [#113](https://github.com/richard-callis/orion-web/pull/113) | — | P2 | TTL-based deletion for AuditLog |

> **Note:** Branches 6-10 are planning-only branches with `IMPLEMENTATION_PLAN.md`. Code to be implemented after Opus review.

### Updated Compliance Matrix

| Finding | Old Status | New Status (After Fixes) |
|---------|-----------|-------------------------|
| [M-001] SQL Injection | ❌ NON-COMPLIANT | ⚠️ PARTIAL — raw SQL converted to Prisma ORM (PR #98) |
| [C-001] Prompt Injection | ❌ NON-COMPLIANT | ⚠️ PARTIAL — sanitization added (PR #102) |
| [C-003] Encryption at Rest | ❌ NON-COMPLIANT | ⚠️ PARTIAL — write-time encryption added (PR #100) |
| [M-005] Audit Logging | ⚠️ PARTIAL | ⚠️ PARTIAL — IP/UA fields added, no writer yet (PR #104) |
| Input Validation | ❌ NON-COMPLIANT | ⚠️ PARTIAL — Zod added to 3 routes (PR #106) |

> **Note:** All other findings retain their original status as the deferred branches have not yet been created.

