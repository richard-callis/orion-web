# SOC 2 Security Audit Report — Orion

**Audit Date:** 2026-04-25
**Scope:** Orion Web (`apps/web/`), Orion Gateway (`apps/gateway/`), Database Schema (`prisma/schema.prisma`)
**Auditor:** Claude Code (Sonnet)
**Current Posture:** FAIL on most SOC 2 controls

## Severity Summary

| Severity | Count | Priority | Target |
|----------|-------|----------|--------|
| CRITICAL | 5 | P0 | Immediate fix required |
| HIGH | 6 | P1 | Fix within 2 weeks |
| MEDIUM | 5 | P2 | Fix within 30 days |
| LOW | 3 | P3 | Nice-to-have |

---

## CRITICAL Findings (P0)

### CR-001: Missing authorization on tool CRUD endpoints

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/68 |
| **SOC 2** | CC6.3 (Role-Based Access) |
| **Files** | `apps/web/src/app/api/environments/[id]/tools/route.ts`, `.../tools/[toolId]/route.ts`, `.../tools/[toolId]/approve/route.ts` |

**Impact:** Unauthenticated actors can add, modify, or delete tools on any environment. The gateway executes these tools with shell commands or HTTP requests.

**Remediation:** Add `requireAuth()` to all handlers; verify user owns the environment; use `requireAdmin()` for bulk operations.

**Annotations:** 7 comments across 3 files

---

### CR-002: Missing authorization on environment CRUD endpoints

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/69 |
| **SOC 2** | CC6.3 (Role-Based Access) |
| **Files** | `apps/web/src/app/api/environments/route.ts` |

**Impact:** Unauthenticated actors can read all environments (with masked tokens) and create new ones.

**Remediation:** Add `requireAuth()` to GET; `requireAdmin()` to POST.

**Annotations:** 3 comments

---

### CR-003: Unauthenticated Kubernetes stream and pod logs endpoints

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/70 |
| **SOC 2** | CC6.1 (Logical Access) |
| **Files** | `apps/web/src/app/api/k8s/stream/route.ts`, `apps/web/src/app/api/k8s/pods/[ns]/[pod]/logs/route.ts` |

**Impact:** Unauthenticated actors can connect to SSE streams for real-time K8s events and read any pod's logs (may contain secrets, tokens, internal IPs).

**Remediation:** Add `requireAuth()` to both endpoints; verify user has access to the target namespace.

**Annotations:** 2 comments

---

### CR-004: SSRF via HTTP execType in gateway tool execution

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/71 |
| **SOC 2** | CC6.5 (Boundary Protection) |
| **Files** | `apps/gateway/src/tool-runner.ts` |

**Impact:** HTTP execType has no URL validation. A malicious tool can make requests to any URL including cloud metadata (`169.254.169.254`), K8s API server, or internal services.

**Remediation:** Block private IP ranges; validate scheme (https only); implement domain allowlist per tool; limit response body size.

**Annotations:** 2 comments

---

### CR-005: LLM prompt injection leads to arbitrary command execution

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/72 |
| **SOC 2** | CC6.8 (Authorized Software), CC6.7 (Data Injection) |
| **Files** | `apps/web/src/app/api/tools/generate/route.ts`, `apps/gateway/src/tool-runner.ts` |

**Impact:** An authenticated user can craft a description that generates a malicious shell command. The tool is saved to DB and executed by the gateway on the next heartbeat (30s).

**Remediation:** Require human approval for all new shell-exec tools; validate commands against allowlist; add rate limiting; implement command sandboxing.

**Annotations:** 4 comments across 2 files

---

## HIGH Findings (P1)

### H-001: Plaintext secrets stored in database

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/73 |
| **SOC 2** | CC6.1 (Logical Access), Confidentiality |
| **Files** | `prisma/schema.prisma` (lines 92, 106, 408) |

**Impact:** `gatewayToken`, `kubeconfig`, and `apiKey` stored in plaintext. Database compromise exposes all secrets.

**Remediation:** Envelope encryption with per-record AES-256-GCM keys, master key in Vault/KMS.

**Annotations:** 3 comments

---

### H-002: Missing CSP and security headers

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/74 |
| **SOC 2** | CC6.5 (Boundary Protection) |
| **Files** | Entire codebase — no CSP headers anywhere |

**Impact:** No XSS protection, no clickjacking defense, no data exfiltration prevention.

**Remediation:** Add CSP, X-Frame-Options, X-Content-Type-Options, HSTS headers via middleware.

---

### H-003: Path traversal in DNS domain setup

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/75 |
| **SOC 2** | CC6.5 (Boundary Protection) |
| **Files** | `apps/web/src/app/api/setup/domain/route.ts` |

**Impact:** Domain parameter from user input used directly in `path.join()` — `../../../etc` could write outside intended directory.

**Remediation:** Validate domain against RFC 1035 regex; resolve final path and verify under target directory.

**Annotations:** 2 comments

---

### H-004: Missing authorization on notes, agent-groups, features endpoints

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/76 |
| **SOC 2** | CC6.3 (Role-Based Access) |
| **Files** | Multiple route files |

**Impact:** Unauthenticated users can read/modify notes, agent groups, features, chatrooms, DNS records. Classic IDOR.

**Remediation:** Add `requireAuth()` to all affected endpoints; implement ownership checks; tenant isolation.

**Annotations:** 2 comments (notes route), more files affected (agent-groups, features, chatrooms, dns/records, tool-approvals)

---

### H-005: Incomplete shell injection prevention

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/77 |
| **SOC 2** | CC6.7 (Data Injection) |
| **Files** | `apps/gateway/src/tool-runner.ts` |

**Impact:** Shell injection filter blocks `[;&|`$<>\\]` but NOT `||`, `&&`, `$()`, shell globbing. Partial bypass possible.

**Remediation:** Use `shlex.quote()` equivalent or pass args as array to `execFile`.

**Annotations:** 2 comments

---

### H-006: Unvalidated auto-package installation

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/78 |
| **SOC 2** | CC6.8 (Authorized Software) |
| **Files** | `apps/gateway/src/tool-runner.ts` |

**Impact:** Gateway auto-installs OS packages via `apk add` from tool definitions with no validation. Arbitrary package installation possible.

**Remediation:** Validate package names with regex; enforce allowlist per toolset; log all installations.

**Annotations:** 2 comments

---

## MEDIUM Findings (P2)

### M-001: SQL injection in API key queries

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/79 |
| **SOC 2** | CC6.7 (Data Injection) |
| **Files** | `apps/web/src/lib/api-key.ts` |

**Impact:** `updateLastUsed` and `deleteByKey` use string concatenation with naive single-quote escaping.

**Remediation:** Use Prisma parameterized queries (`$executeRawUnsafe` with positional params).

**Annotations:** 1 comment

---

### M-002: Insecure cookie configuration (`secure: false`)

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/80 |
| **SOC 2** | CC6.2 (Authentication) |
| **Files** | `apps/web/src/lib/auth.ts` |

**Impact:** Session cookies transmitted over HTTP, vulnerable to MITM interception.

**Remediation:** Set `secure: true` when behind TLS; add `__Secure-` prefix; conditional for dev.

**Annotations:** 4 comments

---

### M-003: No rate limiting on any endpoint

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/81 |
| **SOC 2** | CC6.6 (System Failure Protection) |
| **Files** | Entire codebase |

**Impact:** All endpoints unprotected from brute-force, credential stuffing, resource exhaustion, and DoS.

**Remediation:** Add `express-rate-limit` (already installed); stricter limits on auth endpoints.

---

### M-004: Sensitive data in application logs

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/82 |
| **SOC 2** | CC6.1 (Logical Access), Confidentiality |
| **Files** | `setup-token.ts`, `room-agents.ts`, `localhost.ts` |

**Impact:** Setup tokens, tool arguments/results, shell commands logged in plaintext.

**Remediation:** Structured logging with redaction; log-level filtering for sensitive fields.

---

### M-005: Missing audit fields

| Field | Value |
|-------|-------|
| **GitHub** | https://github.com/richard-callis/orion-web/issues/83 |
| **SOC 2** | CC7.1 (System Monitoring) |
| **Files** | `prisma/schema.prisma` |

**Impact:** No audit trail for who created, modified, or deleted records. Hardcoded `"admin"` as `createdBy` on multiple models.

**Remediation:** Add `createdById`, `updatedBy`, `createdAt`, `updatedAt` to all models; populate from auth context; add indexes.

**Annotations:** 8 comments

---

## LOW Findings (P3)

| ID | Description | Files |
|----|-------------|-------|
| L-001 | Missing DB indexes on `AuditLog.userId`, `AuditLog.createdAt`, `ToolApprovalRequest.status` | `prisma/schema.prisma` |
| L-002 | Missing `X-Frame-Options`, `X-Content-Type-Options` headers | Entire codebase |
| L-003 | No JWT secret key rotation procedure | `apps/web/src/lib/auth.ts` |

---

## SOC 2 Trust Service Criteria Mapping

| Criteria | Description | Status | Affected By |
|----------|-------------|--------|-------------|
| **CC6.1** | Logical & Physical Access | **FAIL** | CR-001, CR-002, CR-003, H-001, H-004, M-004 |
| **CC6.2** | Authentication Procedures | **FAIL** | M-002 |
| **CC6.3** | Role-Based Access | **FAIL** | CR-001, CR-002, H-004 |
| **CC6.5** | Boundary Protection | **FAIL** | CR-004, H-002, H-003, H-005 |
| **CC6.6** | System Failure Protection | **FAIL** | M-003 |
| **CC6.7** | Data Injection Prevention | **FAIL** | CR-005, H-005, M-001 |
| **CC6.8** | Authorized Software | **FAIL** | CR-005, H-006 |
| **CC7.1** | System Operations Monitoring | **WARN** | M-004, M-005 |
| **Confidentiality** | Data at Rest / In Transit | **FAIL** | H-001, H-002, M-002, M-004 |

---

## Inline Annotations

All source files are annotated with `// SOC2: [ID]` comments that link findings to their exact location and describe the remediation needed.

```
apps/gateway/src/tool-runner.ts              6 annotations
apps/web/prisma/schema.prisma                8 annotations
apps/web/src/lib/api-key.ts                  1 annotation
apps/web/src/lib/auth.ts                     4 annotations
apps/web/src/app/api/tools/generate/route.ts 3 annotations
apps/web/src/app/api/k8s/pods/[ns]/[pod]/logs/route.ts  1 annotation
apps/web/src/app/api/k8s/stream/route.ts     1 annotation
apps/web/src/app/api/notes/route.ts          2 annotations
apps/web/src/app/api/environments/route.ts   3 annotations
apps/web/src/app/api/setup/domain/route.ts   2 annotations
apps/web/src/app/api/environments/[id]/tools/route.ts    4 annotations
apps/web/src/app/api/environments/[id]/tools/[toolId]/approve/route.ts  1 annotation
```

---

## Remediation Priority Matrix

| Priority | Items | Effort | Impact if Delayed |
|----------|-------|--------|-------------------|
| **P0** | CR-001 through CR-005 | 2-3 weeks | Immediate SOC 2 failure; active exploitation risk |
| **P1** | H-001 through H-006 | 1-2 weeks | SOC 2 failure; data exposure risk |
| **P2** | M-001 through M-005 | 1-2 weeks | SOC 2 audit questions; compliance gaps |
| **P3** | L-001 through L-003 | 1 week | Nice-to-have; audit advisory items |
