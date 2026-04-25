# SOC 2 Implementation Guide — Orion

> **Purpose:** Guiding document for Opus (or any engineer) to understand the SOC 2 remediation effort: what's done, what's pending, what decisions are needed, and where the changes live.

---

## Current SOC 2 Status

| Tier | Status | Details |
|------|--------|---------|
| **CRITICAL (P0)** | 4/5 fixed | CR-005 is a draft PR pending review |
| **HIGH (P1)** | 4/6 fixed | H-002, H-005, H-006, L-002 (security headers) done. H-001, H-003, H-004 have open PRs. |
| **MEDIUM (P2)** | 5/5 fixed | M-001 through M-005 all have PRs created |
| **LOW (P3)** | 1/3 fixed | L-002 (security headers) done. L-001 (indexes) done. L-003 (JWT rotation) is policy, not code. |

**Overall: ~19 of 25 findings have active PRs on GitHub.**

---

## GitHub Issues Reference

All findings are tracked as GitHub issues on the repo:
- **#67** — Main SOC 2 audit tracking issue with full findings table
- **#68-#72** — CRITICAL findings (CR-001 through CR-005)
- **#73-#78** — HIGH findings (H-001 through H-006)
- **#79-#83** — MEDIUM findings (M-001 through M-005)

---

## Completed PRs (Ready to Review/Merge)

### CRITICAL Fixes

| PR | Issue | What it does | Files changed |
|----|-------|-------------|---------------|
| [#85](https://github.com/richard-callis/orion-web/pull/85) | CR-001 | Adds auth to all tool CRUD endpoints | 3 route files |
| [#86](https://github.com/richard-callis/orion-web/pull/86) | CR-002, CR-003 | Auth on env CRUD + K8s stream/logs | 3 route files |
| [#87](https://github.com/richard-callis/orion-web/pull/87) | CR-004 | SSRF protection in gateway (blocks private IPs, cloud metadata) | `apps/gateway/src/tool-runner.ts` |

### MEDIUM Fixes

| PR | Issues | What it does | Files changed |
|----|--------|-------------|---------------|
| [#89](https://github.com/richard-callis/orion-web/pull/89) | M-002 | Conditional cookie secure flag + `__Secure-` prefix | `apps/web/src/lib/auth.ts` |
| [#90](https://github.com/richard-callis/orion-web/pull/90) | M-003 | Per-path rate limiting (10-100 req/15min) | `apps/web/src/middleware.ts` |
| [#91](https://github.com/richard-callis/orion-web/pull/91) | M-004, M-005, L-001 | Log redaction utility + AuditLog DB indexes | New: `apps/web/src/lib/redact.ts`, `schema.prisma` |
| [#92](https://github.com/richard-callis/orion-web/pull/92) | H-002, L-002 | Security headers (CSP, X-Frame-Options, HSTS, etc.) | `apps/web/src/middleware.ts` |
| [#96](https://github.com/richard-callis/orion-web/pull/96) | H-005, H-006, M-004 | Shell quoting, package validation, log redaction wiring | New: `gateway/src/lib/*`, `tool-runner.ts`, `localhost.ts`, `redact.ts` |

### In Review (Draft)

| PR | Issue | Status |
|----|-------|--------|
| [#88](https://github.com/richard-callis/orion-web/pull/88) | CR-005 | Draft — needs review of LLM command sanitization approach |

---

## Pending Work — Decision Points

### DECISION 1: H-001 — Encrypt secrets at rest (Plaintext in DB)

**GitHub:** #73 | **Severity:** HIGH | **SOC 2:** Confidentiality

**Current state:** `gatewayToken`, `kubeconfig`, and `apiKey` stored in plaintext in PostgreSQL.

**Existing infrastructure:** `apps/web/src/lib/encryption.ts` already provides AES-256-GCM encryption with transparent decrypt. Uses `ORION_ENCRYPTION_KEY` env var (32 bytes, base64).

**Decision needed:**
1. Which fields to encrypt? All three (`gatewayToken`, `kubeconfig`, `apiKey`).
2. Encryption strategy: The existing `encryption.ts` uses a single symmetric key. Two options:
   - **Option A (Simple):** Use the existing `encryption.ts` directly — same key for all fields. Good enough for homelab scale.
   - **Option B (Envelope):** Per-record encryption key, encrypted with master key in `encryption.ts`. Better security but more complex.
3. Migration: Existing plaintext values must be re-encrypted on next write. The `decrypt()` function already handles plaintext passthrough (returns as-is if no `enc:v1:` prefix), so backward-compatible migration is straightforward.

**Recommendation:** Option A with the existing `encryption.ts`. Add a one-time migration script that reads existing plaintext values and re-encrypts them.

---

### DECISION 2: H-003 — Path traversal in DNS domain setup (GitHub #75)

**GitHub:** #75 | **Severity:** HIGH | **SOC 2:** CC6.5

**Current state:** Domain parameter from user input used directly in `path.join()` without validation. Value like `../../../etc` could write outside the intended directory.

**Files involved:**
- `apps/web/src/app/api/setup/domain/route.ts` (line 70-77)
- `apps/web/src/lib/dns-sync.ts` (line 70) — same pattern via gateway exec

**Decision needed:**
1. Validation approach: RFC 1035 domain name regex validation (`/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/`)
2. Defense in depth: After joining, resolve the final path and verify it's still under the intended directory.

**Recommended approach:** Both — validate input AND verify final path. Simple to implement.

---

### DECISION 3: H-004 — Missing authorization on notes, agent-groups, features

**GitHub:** #76 | **Severity:** HIGH | **SOC 2:** CC6.3

**Current state:** Multiple resources lack proper authentication and authorization checks within route handlers. The NextAuth middleware blocks unauthenticated access, but within authenticated requests, there are no per-resource ownership checks.

**Reference implementation:** ChatRooms (`apps/web/src/app/api/chatrooms/[id]/route.ts`) — uses `getServerSession(authOptions)`, checks `createdBy === userId` for owner-only operations, returns 403 for forbidden.

**Decisions needed:**

#### 3a: Notes
- **Schema:** `Note` model has NO `userId` or `ownerId` field.
- **Decision:** Add `userId` field to Note model? Or keep notes as shared resources?
  - **Option A (Per-user):** Add `userId` field, users only see/edit their own notes. More secure, requires migration.
  - **Option B (Shared):** Keep as-is but add `requireAuth()` to all routes. Any authenticated user can read/modify all notes.
- **Recommendation:** Option A — add `userId` field, populate from session in POST handlers.

#### 3b: AgentGroups
- **Schema:** No `userId`, no `ownerId`. AgentGroups are global resources (not per-environment).
- **Decision:** Admin-only or user-manageable?
  - **Recommendation:** `requireAdmin()` — agent groups control tool access for agents, this is an admin operation.

#### 3c: Features / Epics
- **Schema:** Have `createdBy` (string, defaults to "admin") but no FK to User.
- **Decision:** Keep `createdBy` as string or make FK to User?
  - **Recommendation:** Keep as string but populate from `session.user.id` instead of body. Add ownership checks for PUT/DELETE.

#### 3d: Task, Bug, DnsRecord, etc.
- Similar pattern — have `createdBy`/`reportedBy` strings but no route-level ownership checks.
- **Recommendation:** Add `requireAuth()` + ownership checks following ChatRooms pattern.

---

### DECISION 4: H-005 — Shell injection gaps in gateway

**GitHub:** #77 | **Severity:** HIGH | **SOC 2:** CC6.7

**Status: FIXED** in [PR #96](https://github.com/richard-callis/orion-web/pull/96).

**Implementation:** Replaced regex blocklist with `quote()` function in `apps/gateway/src/lib/shell-quote.ts`. All `{arg_name}` placeholders are now properly single-quoted. Defense-in-depth: `localhost.ts` `shell_exec` also has dangerous pattern blocklist + metacharacter check for full-command input.

**Approach taken:** Approach A — proper shell quoting. Strongest guarantee with minimal changes.

---

### DECISION 5: H-006 — Unvalidated auto-package installation

**GitHub:** #78 | **Severity:** HIGH | **SOC 2:** CC6.8

**Status: FIXED** in [PR #96](https://github.com/richard-callis/orion-web/pull/96).

**Implementation:** Added `validatePackageName()` in `apps/gateway/src/lib/shell-quote.ts` — package names must match `^[a-zA-Z][a-zA-Z0-9._+-]*$` (max 127 chars). All `apk add` calls now go through this validation before execution.

**Approach taken:** Approach A (regex validation).

---

### DECISION 6: M-004 — Wire in the log redaction utility

**GitHub:** #82 | **SOC 2:** Confidentiality

**Status: FIXED** in [PR #96](https://github.com/richard-callis/orion-web/pull/96).

**Implementation:** Added `wrapConsoleLog()` in `apps/web/src/lib/redact.ts` and `apps/gateway/src/lib/redact.ts`. Called once at startup in both `middleware.ts` and `index.ts`. Automatically redacts tokens, keys, passwords from all `console.log` output.

**Approach taken:** Option B — global `console.log` wrapper. One-line call per entry point.

**Deployment note:** `ORION_GATEWAY_TOKEN` must be set in `.env` for both `orion` and `gateway` services in `docker-compose.yml`. The gateway needs this token to authenticate API calls back to ORION.

---

### DECISION 7: Rate limiting — in-memory vs Redis

**GitHub:** #81 | **SOC 2:** CC6.6

**Current state:** Implemented in-memory rate limiter in `middleware.ts`. Works for single-instance deployments.

**Decision needed:** For production with multiple replicas (Kubernetes), the in-memory store won't work.
- **Recommendation:** In-memory is fine for now. Add a TODO comment noting that Redis-backed rate limiter (e.g., `@upstash/ratelimit`) should be swapped in for multi-replica production. This is a P3 follow-up, not blocking SOC 2.

---

## M-001 Fix Already Applied (No Decision Needed)

The SQL injection in `api-key.ts` has been fixed: `updateLastUsed` and `deleteByKey` now use parameterized queries (`$1`, `$2`) instead of string concatenation. See PR #91.

---

## L-001 Fix Already Applied (No Decision Needed)

AuditLog database indexes added: `@@index([userId])`, `@@index([createdAt])`, `@@index([userId, createdAt])`. See PR #91.

---

## L-003: JWT Rotation (Policy, Not Code)

This is a procedural concern, not a code fix. SOC 2 auditors will want to see a documented policy for:
- How often `NEXTAUTH_SECRET` should be rotated
- The rotation procedure (generate new secret, update env, deploy, verify)
- Backward compatibility during rotation (JWTs from old secret will expire naturally)

**Recommendation:** Document in `DEPLOYMENT.md` or `SECURITY_POLICIES.md` — rotate every 90 days minimum.

---

## Files Changed Summary (All PRs Combined)

| File | PR | Change Type |
|------|----|------------|
| `apps/web/src/lib/auth.ts` | M-002 | Conditional secure cookies |
| `apps/web/src/middleware.ts` | L-002 | Security headers |
| `apps/web/src/middleware.ts` | M-003 | Rate limiting |
| `apps/web/src/lib/api-key.ts` | M-001 (in #91) | Parameterized SQL |
| `apps/web/src/lib/redact.ts` | M-004 (in #91) | New: log redaction utility |
| `apps/web/prisma/schema.prisma` | M-005/L-001 (in #91) | AuditLog indexes |
| `apps/web/src/app/api/environments/route.ts` | CR-002 | Auth on env CRUD |
| `apps/web/src/app/api/environments/[id]/tools/route.ts` | CR-001 | Auth on tool CRUD |
| `apps/web/src/app/api/environments/[id]/tools/[toolId]/route.ts` | CR-001 | Auth on tool CRUD |
| `apps/web/src/app/api/environments/[id]/tools/[toolId]/approve/route.ts` | CR-001 | Admin-only approval |
| `apps/web/src/app/api/k8s/stream/route.ts` | CR-003 | Auth on K8s events SSE |
| `apps/web/src/app/api/k8s/pods/[ns]/[pod]/logs/route.ts` | CR-003 | Auth on pod logs |
| `apps/web/src/app/api/tools/generate/route.ts` | CR-005 | Auth + command sanitization |
| `apps/gateway/src/tool-runner.ts` | CR-004 | SSRF URL validation |
| `apps/gateway/src/lib/shell-quote.ts` | H-005, H-006 (in #96) | **NEW:** `quote()` + `validatePackageName()` |
| `apps/gateway/src/lib/redact.ts` | M-004 (in #96) | **NEW:** `wrapConsoleLog()` |
| `apps/gateway/src/builtin-tools/localhost.ts` | H-005 (in #96) | Dangerous pattern blocklist |
| `apps/web/src/lib/redact.ts` | M-004 (in #96) | `wrapConsoleLog()` export |
| `deploy/docker-compose.yml` | M-004 (in #96) | `ORION_GATEWAY_TOKEN` env var

---

## Recommended Implementation Order for Pending Work

1. **H-001** — Encrypt secrets (straightforward, uses existing `encryption.ts`)
2. **H-003** — Path traversal validation (simple regex + path check)
3. **H-004** — Authorization (needs decisions above, then follow ChatRooms pattern)

---

## SOC 2 Control Mapping (After All Fixes)

| Control | Before | After (current PRs) | After (all pending) |
|---------|--------|---------------------|---------------------|
| CC6.1 Logical Access | FAIL | FAIL (P0 pending) | PASS |
| CC6.2 Authentication | FAIL | PASS (M-002) | PASS |
| CC6.3 Role-Based Access | FAIL | PARTIAL | PASS |
| CC6.5 Boundary Protection | FAIL | PASS (H-002, CR-004) | PASS |
| CC6.6 System Failure | FAIL | PASS (M-003) | PASS |
| CC6.7 Data Injection | FAIL | PASS (H-005) | PASS |
| CC6.8 Authorized Software | FAIL | PASS (H-006) | PASS |
| CC7.1 Monitoring | WARN | PASS (M-005) | PASS |
| Confidentiality | FAIL | PASS (M-002) | PASS |
