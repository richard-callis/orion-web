# ORION SOC II Compliance Audit Report

**Date**: 2026-04-25
**Auditor**: Claude Code (Sonnet)
**Scope**: ORION application codebase (`/opt/orion`)
**Classification**: Internal — Review by Opus only

---

## Executive Summary

ORION has **solid foundational security** — strong CSP headers, bcrypt password hashing, rate-limited auth endpoints, AES-256-GCM encryption, shell command blocklists, and SSRF protection in the gateway. However, there are **critical gaps** in audit logging coverage, tamper-proofing, session management, and input validation that would prevent a SOC II Type II certification.

**Overall Maturity: Level 2 (Defined)** — Many controls are ad-hoc or incomplete. None of the controls are fully automated, tested, or externally validated.

---

## Table of Contents

1. [Authentication & Identity (A1–A3)](#1-authentication--identity-a1a3)
2. [Audit Logging (CC5, CC6, CC7)](#2-audit-logging-cc5-cc6-cc7)
3. [Data Protection & Encryption (C1)](#3-data-protection--encryption-c1)
4. [Input Validation & Injection Prevention (C1, CC7)](#4-input-validation--injection-prevention-c1-cc7)
5. [Error Handling & Information Leakage (CC7)](#5-error-handling--information-leakage-cc7)
6. [Availability & Business Continuity (D1)](#6-availability--business-continuity-d1)
7. [Network Security (CC6, CC7)](#7-network-security-cc6-cc7)
8. [SOC II Trust Service Criteria Mapping](#8-soc-ii-trust-service-criteria-mapping)
9. [Branch & Fix Strategy](#9-branch--fix-strategy)

---

## 1. Authentication & Identity (A1–A3)

### Critical

| # | Finding | File | Line |
|---|---------|------|------|
| C1 | **Setup wizard uses hardcoded `'fallback-secret'`** — anyone can forge a wizard JWT and create an admin account on any instance without `NEXTAUTH_SECRET` set | `apps/web/src/lib/setup-guard.ts` | 8 |
| C2 | **Gitea admin credentials exposed** in plaintext via unauthenticated `/api/setup/bootstrap-config` endpoint | `apps/web/src/app/api/setup/bootstrap-config/route.ts` | 18-20 |

### High

| # | Finding | File | Line |
|---|------|------|------|
| H1 | **Gateway token (`ORION_GATEWAY_TOKEN`) grants near-complete admin access** — any route under `/api/admin` is accessible via bearer token with no RBAC check | `apps/web/src/middleware.ts` | 152-164 |
| H2 | **Header-based SSO accepts spoofable `x-forwarded-user`** — no source verification, no IP allowlist | `apps/web/src/lib/auth.ts` | 208 |
| H3 | **No account lockout** — rate limiting is in-memory, bypassable via IP rotation or header spoofing | `apps/web/src/middleware.ts` | 16-22 |
| H4 | **Middleware session cookie name mismatch** — hardcoded `'next-auth.session-token'` but production uses `'__Secure-next-auth.session-token'` (line 37 of `auth.ts`), causing session bypass in production | `apps/web/src/middleware.ts` | 183 |
| H5 | **No session invalidation on password change** — JWT tokens remain valid until expiry (30 days) even after password reset | `apps/web/src/lib/auth.ts` | 79-144 |

### Medium

| # | Finding |
|---|------|
| M1 | No password complexity requirements — only 10-char minimum at setup |
| M2 | No user password-change flow (no self-service reset) |
| M3 | Session `maxAge` defaults to 30 days with no idle timeout |
| M4 | No concurrent session limits or tracking |
| M5 | MFA status leaks user existence via `"MFA not enabled for this account"` error |
| M6 | JWT signing key has **no rotation mechanism** — compromised key forges sessions for up to 30 days |

### Low

| # | Finding |
|---|------|
| L1 | Callback cookie uses `sameSite: 'lax'` (by design) |
| L2 | No email verification for auto-created SSO users |

---

## 2. Audit Logging (CC5, CC6, CC7)

### Critical

| # | Finding |
|---|------|
| C1 | **Audit logs are NOT tamper-proof** — no hash chain, no WORM storage, no external shipping. Any admin can modify/delete logs via direct DB access |
| C2 | **Admins can manually delete audit logs** via `POST /api/admin/audit-retention/cleanup` at any time, bypassing retention policies |

### High

| # | Finding | Events Missing |
|---|------|--------|
| H1 | **Auth events NOT logged** — login success/failure, MFA enable/disable/verify, SSO login | `user_login`, `user_login_failure`, `mfa_enable`, `mfa_disable`, `mfa_verify` |
| H2 | **Admin actions NOT logged** — user creation/role change/deletion, SSO config, system settings, model config | All `/api/admin/*` mutations |
| H3 | **Environment lifecycle NOT logged** — update and delete actions have no audit trail |
| H4 | **logAudit() silently swallows errors** — non-blocking fire-and-forget with no alerting | `src/lib/audit.ts` | 49-72 |

### Medium

| # | Finding |
|---|------|
| M1 | Audit log page shows only last 100 entries — no filtering by date/user/action/IP |
| M2 | No export capability (CSV/JSON) for auditors |
| M3 | Audit log page doesn't display stored `ipAddress` or `userAgent` fields |
| M4 | Only 3 of 37+ defined audit action types are actually called in code |

---

## 3. Data Protection & Encryption (C1)

### High

| # | Finding |
|---|------|
| H1 | **Encryption key rotation is operationally broken** — `/api/internal/encryption/rotate` requires the current key at request time, creating a chicken-and-egg problem for `ORION_ENCRYPTION_KEY` |
| H2 | **Internal Docker network is plaintext HTTP** — `VAULT_ADDR: http://vault:8200`, `ORION_URL: http://orion:3000`, PostgreSQL connection without `?sslmode=require` |

### Medium

| # | Finding |
|---|------|
| M1 | No database-level encryption (only application-level middleware) |
| M2 | No database backup encryption found |
| M3 | Gemini API key passed as URL query parameter — may appear in access logs |
| M4 | `Environment.kubeconfig` stored as base64 (not encrypted) despite schema comment |
| M5 | PII (emails, names, usernames) stored in plaintext in `User` and `AuditLog` tables |
| M6 | Deleted users persist in `AuditLog` (no cascade delete) — orphaned references |

---

## 4. Input Validation & Injection Prevention (C1, CC7)

### High

| # | Finding | File | Line |
|---|------|------|------|
| H1 | **`kubectl_apply_url` bypasses SSRF protection** — user URL passed directly to `kubectl apply -f <url>`, can reach internal metadata services | `apps/gateway/src/builtin-tools/kubernetes.ts` | 172-186 |
| H2 | **`docker_exec` accepts arbitrary commands** — no allowlist, no validation, passed directly to `sh -c` | `apps/gateway/src/builtin-tools/docker.ts` | 71-84 |
| H3 | **`docker_run` accepts arbitrary volume mounts** — can mount host paths like `/etc`, `/var/run/docker.sock` | `apps/gateway/src/builtin-tools/docker.ts` | 86-123 |

### Medium

| # | Finding |
|---|------|
| M1 | `file_read` tool lacks path traversal validation |
| M2 | `helm_upgrade_install` `--set` flags not sanitized or quoted |
| M3 | No request body validation on most POST/PUT routes |
| M4 | No `Content-Type` enforcement on API endpoints |
| M5 | No request body size limits |

---

## 5. Error Handling & Information Leakage (CC7)

### Medium

| # | Finding |
|---|------|
| M1 | **Raw SDK/API error messages forwarded to clients** throughout agent runners and gateway — can leak internal paths, env details, k8s errors |
| M2 | Gateway REST API returns full error message in JSON response body |
| M3 | Console.log in worker.ts bypasses the redaction wrapper |
| M4 | Encryption key info logged (`Key length: X bytes`) |

---

## 6. Availability & Business Continuity (D1)

### High

| # | Finding |
|---|------|
| H1 | **No graceful shutdown** — worker exits with `process.exit(1)` on fatal errors, no cleanup of running tasks |
| H2 | **No health check endpoint for the worker process** — container orchestrator can't detect if worker is alive |
| H3 | **No circuit breaker pattern** for external API calls (Claude, Ollama, OpenAI) |

### Medium

| # | Finding |
|---|------|
| M1 | No connection pool configuration for Prisma/PostgreSQL |
| M2 | No load balancer configuration between ORION instances |
| M3 | Gateway heartbeat every 30s but no stale-state/hang detection |
| M4 | No disaster recovery plan or backup restore testing |

---

## 7. Network Security (CC6, CC7)

### Medium

| # | Finding |
|---|------|
| M1 | **No namespace isolation** in Kubernetes client — default service account has cluster-wide read access |
| M2 | **No explicit CORS configuration** on web or gateway |
| M3 | Gateway MCP SSE/REST endpoints have no CORS headers — accessible from any origin if publicly reachable |
| M4 | **No replay attack prevention** on webhook handlers (no timestamp/nonce validation) |

### Low

| # | Finding |
|---|------|
| L1 | `X-XSS-Protection: 1; mode=block` header is deprecated in modern browsers |
| L2 | No `Cross-Origin-Embedder-Policy` or `Cross-Origin-Opener-Policy` headers |

---

## 8. SOC II Trust Service Criteria Mapping

| Criteria | Status | Key Gaps |
|----------|--------|----------|
| **Security (Common Criteria)** | | |
| CC2 — Communication & info quality | PARTIAL | Audit logging severely under-implemented (3 of 37 action types) |
| CC5 — Controls monitoring | PARTIAL | Audit logs exist but not tamper-proof; no alerting on failures |
| CC6 — Logical access | HIGH RISK | Fallback secret, gateway token bypass, spoofable SSO header |
| CC7 — System operations | PARTIAL | Error leakage, no graceful shutdown, no worker health check |
| **Security (Tech Criteria)** | | |
| C1 — Encryption | PARTIAL | Good at boundary, weak internally; no key rotation strategy |
| C1 — Input validation | PARTIAL | SSRF bypass, command injection in docker_exec |
| C1 — Data protection | PARTIAL | Application-level encryption only; PII in plaintext |
| C6 — Availability | AT RISK | No graceful shutdown, no circuit breakers, no worker health check |

---

## 9. Branch & Fix Strategy

### Fix Priority

**P0 (critical — must fix immediately):**
1. Remove `'fallback-secret'` from `setup-guard.ts` — block setup if `NEXTAUTH_SECRET` is unset
2. Add auth gate to `/api/setup/bootstrap-config`
3. Fix cookie name mismatch in `middleware.ts` line 183
4. Scope gateway token — add `requireAdmin()` check for `/api/admin/*` routes

**P1 (high — fix this sprint):**
5. Implement comprehensive audit logging for auth, admin, and env events
6. Make audit logs tamper-proof (hash chain + external shipping)
7. Add SSRF protection to `kubectl_apply_url` tool
8. Add input validation to `docker_exec` and `docker_run`
9. Implement session invalidation on password change

**P2 (medium — fix next quarter):**
10. Encrypt all PostgreSQL connections (`?sslmode=require`)
11. Implement encryption key rotation strategy
12. Add worker health check endpoint and graceful shutdown
13. Add auditor-facing audit log export (CSV/JSON with filtering)
14. Rate-limit SSO header auth by source IP
15. Add MFA status generic error message

### Branch Naming Convention

Each P0/P1 fix gets its own feature branch, named `soc2-fix-<short-description>`:

```
soc2-fix-fallback-secret          — P0: Remove hardcoded fallback secret
soc2-fix-bootstrap-config-auth    — P0: Auth gate on bootstrap-config
soc2-fix-cookie-name-mismatch     — P0: Fix middleware session cookie lookup
soc2-fix-gateway-token-scope      — P0: Scope gateway token for admin routes
soc2-fix-audit-log-comprehensive  — P1: Audit all auth/admin/env events
soc2-fix-ssrf-kubectl-apply       — P1: SSRF protection on kubectl apply URL
soc2-fix-docker-input-validation  — P1: Validate docker_exec and docker_run inputs
soc2-fix-session-password-inval   — P1: Invalidate sessions on password change
```

### PR Strategy

- **One PR per fix** — each is independently reviewable and mergeable
- **Squash-merge** each PR into the `feat/merge-messages` feature branch (not `main`)
- **Opus reviews each PR** before merging
- **Never push directly to `main`**
- All branches are prefixed with `soc2-fix-`

### Downstream Effects to Consider

**P0 fixes (low risk):**
- `fallback-secret` removal: Only affects first-time setup. If `NEXTAUTH_SECRET` is already configured, no change.
- `bootstrap-config` auth gate: Only affects setup flow. Setup should already be restricted, but adding explicit auth is safe.
- Cookie name mismatch: **High impact fix** — must also test that session middleware reads the correct cookie. If this fix is correct, middleware will properly authenticate users in production.
- Gateway token scoping: Gateway won't be able to access admin routes. Ensure admin tasks still go through authenticated user sessions, not gateway token.

**P1 fixes (medium risk):**
- Audit logging: Fire-and-forget with error swallowing. Must not break existing flows if audit write fails. Adding to auth.ts means every login/logout logs — verify no performance regression.
- SSRF protection: `kubectl_apply_url` currently accepts any URL. Adding SSRF validation will reject internal URLs. Update documentation to inform users they must use publicly accessible YAML URLs.
- Docker input validation: Adding allowlists will break existing workflows using arbitrary commands. Must document breaking changes.
- Session invalidation: Requires adding a `passwordChangedAt` timestamp to `User` model and checking it in the JWT callback. **Database migration required.**

---

*End of audit report*
