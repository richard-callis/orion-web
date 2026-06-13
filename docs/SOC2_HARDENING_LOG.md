# SOC2 Hardening Log — ORION (PRs #610–#633)

> **Audience**: SOC2 auditors verifying the ORION hardening programme.
> This document provides a chronological log of all security improvements made across PRs #610 through #633,
> including the SOC2 Trust Service Criteria addressed, files changed, and the security gap each change closed.

---

## How to Read This Document

Each entry is structured as:

- **PR number and title** — maps directly to the git log
- **SOC2 Criteria** — TSC codes addressed (CC = Common Criteria, C = Confidentiality, A = Availability)
- **Files changed** — source files modified (auditors can `git diff <prev>...<pr-commit>` to verify)
- **Gap closed** — the specific security weakness that existed before this PR and what was fixed

---

## PR #610 — `security: comprehensive hardening pass`

**Commit**: `6c8f872`

### SOC2 Criteria Addressed
- **CC6.1** — Logical and physical access controls
- **CC6.7** — Encryption of data in transit and at rest
- **CC7.2** — System monitoring and detection

### Files Changed
- `apps/web/src/lib/encryption.ts` (new)
- `apps/web/src/lib/validate.ts` (new/extended)
- `apps/web/src/lib/redact.ts` (new)
- `apps/web/prisma/schema.prisma` — added encrypted fields to `Environment`, `User`
- Multiple API route files — added `requireAdmin()` guards

### What Was Fixed

**Encryption at rest (initial pass)**: Introduced `apps/web/src/lib/encryption.ts` implementing AES-256-GCM encryption with the `enc:v1:` prefix format. Began encrypting `Environment.kubeconfig` and sensitive `SystemSetting` values. Before this PR, these fields were stored as plaintext in PostgreSQL.

**Input validation framework**: Created `apps/web/src/lib/validate.ts` with Zod schemas for all major API inputs. Before this PR, many API routes accepted raw JSON bodies without type or length validation, allowing oversized or malformed inputs.

**Secrets redaction in logs**: Created `apps/web/src/lib/redact.ts` with `wrapConsoleLog()` and `redactSensitive()`. Called at application startup to wrap all `console.*` methods. Before this PR, sensitive values (API keys, tokens, kubeconfigcredentials) could appear in server logs in plaintext.

**Authorization guards**: Added `requireAdmin()` calls to admin-only API routes that were previously accessible by any authenticated user.

---

## PR #611 — `security: audit logging gaps, federation task injection, webhook sanitization`

**Commit**: `a2f23fe`

### SOC2 Criteria Addressed
- **CC7.2** — Monitoring and detection of security events
- **CC6.1** — Access controls on sensitive operations
- **C1.2** — Confidentiality of sensitive information in transit

### Files Changed
- `apps/web/src/lib/audit.ts` — added missing event types
- `apps/web/src/lib/validate.ts` — `CreateAgentSchema` control-character restriction
- `apps/web/src/app/api/federation/` — task description sanitization
- Webhook handler routes — input sanitization

### What Was Fixed

**Audit logging gaps**: Several security-relevant actions were not generating audit log entries. Added audit calls for user role changes, MFA operations, SSO configuration updates, and API key lifecycle events. Before this PR, an admin could change a user's role without any audit trail.

**Agent name prompt injection**: `CreateAgentSchema` was extended to forbid control characters (regex `/^[^\x00-\x1f\x7f]+$/`). Agent names are interpolated into LLM system prompts in `room-agents.ts`. Before this PR, a malicious agent name containing `\n` could inject arbitrary instructions into the system prompt sent to Claude.

**Federation task injection**: Tasks dispatched from spoke environments to the hub were passed through without sanitization of the `description` and `title` fields. A compromised spoke could inject prompt content. Fixed by running spoke-originated task fields through `sanitizeTitle()` before worker ingestion.

**Webhook payload sanitization**: Webhook trigger payloads were not sanitized before being embedded in task descriptions created by the webhook handler. Added sanitization to prevent task content injection via webhook delivery.

---

## PR #612 — `SOC2 hardening batch 2: audit cleanup safety, tool registry, secrets exposure`

**Commit**: `728b7e3`

### SOC2 Criteria Addressed
- **CC7.2** — Monitoring integrity
- **CC6.1** — Access controls on tool execution
- **C1.1** — Protection against unauthorized information disclosure

### Files Changed
- `apps/web/src/lib/audit-export.ts` — safe delete by ID fix
- `apps/web/src/lib/tool-registry.ts` — registry access controls
- `apps/web/src/lib/redact.ts` — extended field-level redaction
- Various API routes — secrets exposure fixes

### What Was Fixed

**Audit cleanup race condition**: `exportAuditLogs()` previously deleted audit records by re-querying a time window after upload. Records written between the export query and the delete query were permanently lost — an audit gap. Fixed by capturing the exact set of row IDs at query time and deleting only those IDs (`deleteExportedLogs(exportedIds: string[])`).

**Tool registry authorization**: Tool execution endpoints were not consistently checking that the requesting agent had permission to invoke the tool. Added tool group tier checks to the registry dispatch path. Before this fix, any agent with a session token could invoke admin-tier tools by calling the API directly.

**Secrets exposure in API responses**: Several API routes returned full database records including sensitive fields (`gatewayToken`, `kubeconfig`, `apiKey`) in their JSON responses. Applied `redactObjectFields()` to strip these fields before returning responses. Extended `redact.ts` with `redactNestedFields()` for deeply nested objects.

---

## PR #613 — `SOC2 hardening batch 3: MFA enforcement, SSO startup alarm, settings redaction`

**Commit**: `db7131d`

### SOC2 Criteria Addressed
- **CC6.1** — Access controls require MFA for privileged operations
- **CC6.3** — Multi-factor authentication enforcement
- **CC7.1** — System configuration monitoring

### Files Changed
- `apps/web/src/lib/auth.ts` — `requireAdmin()` MFA check
- `apps/web/src/app/api/admin/` — SSO config audit logging
- `apps/web/src/lib/auth.ts` — SSO startup alarm
- `apps/web/src/app/api/settings/` — sensitive settings redaction in responses

### What Was Fixed

**MFA enforcement for admins**: Before this PR, `requireAdmin()` only checked `user.role === 'admin'`. An admin who had enrolled TOTP but not yet verified it in the current session could still access all admin endpoints. Fixed:
```ts
if (user.totpEnabled && !user.mfaVerified) {
  throw new Error('MFA verification required')
}
```

**SSO audit logging**: Changes to the `OIDCProvider` (SSO configuration) were not generating audit log entries. Any admin could enable/disable SSO, change header mode, or update group mappings without a trace. Added `logAudit({ action: 'sso_config_update' })` to the SSO admin route.

**SSO startup alarm**: If `OIDCProvider.headerMode` was enabled but `SSO_HMAC_SECRET` was not configured, ORION would silently accept all SSO header requests (including forged ones). Added a startup warning that logs prominently when this misconfiguration is detected.

**Sensitive settings redaction**: The `/api/settings` GET endpoint returned raw `SystemSetting` values, which could include encrypted API keys, git tokens, and other secrets (still in `enc:v1:` format, but exposing encrypted blobs unnecessarily). Added field-level redaction to the settings list response.

---

## PR #614 — `auth errors return null, session 8h maxAge, password min 12 chars, SSO audit`

**Commit**: *(between db7131d and previous)*

### SOC2 Criteria Addressed
- **CC6.1** — Session timeout and authentication controls
- **CC6.3** — Password policy enforcement
- **CC7.2** — Authentication event monitoring

### Files Changed
- `apps/web/src/lib/auth.ts` — session `maxAge`, error handling
- `apps/web/src/lib/validate.ts` — password minimum length
- `apps/web/src/app/api/auth/` — SSO audit events

### What Was Fixed

**Auth errors return null (not exceptions)**: The `CredentialsProvider.authorize()` callback was throwing exceptions on auth failure in some paths. NextAuth interprets a thrown exception as a server error (HTTP 500) rather than an authentication failure (HTTP 401). Fixed all failure paths to `return null`, ensuring failed logins return 401 to the client instead of 500. This also prevents server error details from leaking in error responses.

**Session 8-hour maxAge**: Sessions previously had no explicit `maxAge`, defaulting to NextAuth's 30-day default. Reduced to 8 hours (28,800 seconds) to limit the exposure window of a stolen session cookie, aligning with SOC2 CC6.1 session management requirements.

**Password minimum 12 characters**: The `CreateUserSchema` and `UpdateUserSchema` password minimum was raised to 12 characters. This aligns with NIST SP 800-63B and SOC2 CC6.1 password policy requirements. Passwords shorter than 12 characters are now rejected with a 400 validation error.

**SSO login audit events**: SSO-authenticated logins (via Authentik header mode) were not generating `user_login` audit events. Added audit logging to the SSO user lookup/upsert path in `getCurrentUser()`, ensuring SSO logins are traceable in the audit log.

---

## PR #615 — `encrypt federation tokens + webhook secrets at rest, extend key rotation`

**Commit**: *(sequential)*

### SOC2 Criteria Addressed
- **CC6.7** — Encryption of sensitive data at rest
- **C1.2** — Confidentiality of federation and webhook credentials

### Files Changed
- `apps/web/src/lib/encryption.ts` — `encryptWithKey()`, `decryptWithKey()` for rotation
- `apps/web/prisma/schema.prisma` — noted encrypted fields in comments
- `apps/web/src/app/api/environments/` — encrypt `federationToken` on write
- `apps/web/src/app/api/webhooks/` — encrypt `WebhookTrigger.secret` on write
- Key rotation API endpoint

### What Was Fixed

**Federation tokens unencrypted**: `Environment.federationToken` (the shared secret used for hub-spoke authentication) was stored as plaintext in the `Environment` table. A read of the `environments` table would expose all federation credentials. Encrypted with AES-256-GCM on write.

**Webhook secrets unencrypted**: `WebhookTrigger.secret` (used for HMAC verification of inbound webhooks from GitHub, Prometheus, etc.) was stored as plaintext. Encrypted with AES-256-GCM on write.

**Key rotation support**: Added `encryptWithKey()` and `decryptWithKey()` functions to `encryption.ts` that accept an explicit key parameter. This enables a rotation workflow: re-encrypt all sensitive fields with the new key, then update `ORION_ENCRYPTION_KEY`. Previously the encryption module only supported the single active key, with no rotation path.

---

## PR #616 — `MinIO/Redis credential generation, startup env validation, federation HTTPS enforcement`

**Commit**: *(sequential)*

### SOC2 Criteria Addressed
- **CC6.1** — Credential management for infrastructure components
- **CC6.7** — Encryption in transit for external connections
- **CC7.1** — System configuration integrity at startup
- **A1.2** — System availability via proper configuration

### Files Changed
- `deploy/bootstrap.sh` — credential generation
- `deploy/docker-compose.yml` — credential injection
- `apps/web/src/lib/federation.ts` — HTTPS enforcement
- `apps/web/src/app/` startup validation

### What Was Fixed

**Weak default infrastructure credentials**: The bootstrap script previously used static default credentials for MinIO (`minioadmin`/`minioadmin`) and Redis (no password). Any attacker with network access to the deployment could access all stored data. Fixed by generating cryptographically random credentials during bootstrap using `openssl rand -base64 32`.

**Startup without required secrets**: The application could start without `ORION_ENCRYPTION_KEY` set, silently operating without encryption. If a request then triggered an encrypt/decrypt call, it would throw a runtime error rather than failing at startup. Added startup validation that immediately exits with a clear error message if required environment variables are missing or malformed.

**Federation over HTTP**: The federation client (`federation.ts`) allowed spoke URLs and hub URLs using plain `http://` scheme. A MITM attacker on the network between hub and spoke could read or inject task data. Fixed by validating that all federation URLs begin with `https://` and rejecting configuration with HTTP URLs.

---

## PR #617 — `audit logs for gateway join, gatewayUrl changes, setup wizard, CI health check exit code`

**Commit**: *(sequential)*

### SOC2 Criteria Addressed
- **CC7.2** — Detection and monitoring of infrastructure changes
- **CC6.1** — Audit trail for gateway provisioning

### Files Changed
- `apps/web/src/app/api/environments/join/` — `gateway_joined` audit event
- `apps/web/src/app/api/environments/[id]/` — `gatewayUrl_changed` audit event
- `apps/web/src/app/api/setup/` — setup wizard audit events
- `deploy/ci/` — health check exit code fix

### What Was Fixed

**No audit trail for gateway joins**: When a new gateway joined an environment (using a one-time join token), no audit event was generated. An operator had no way to verify when or from where gateways joined. Added `logAudit({ action: 'gateway_joined', detail: { environmentId, machineId, gatewayType } })` on successful join token use.

**No audit trail for gateway URL changes**: Changes to `Environment.gatewayUrl` (which determines where ORION sends commands) were not audited. An attacker who gained database write access could redirect commands to a malicious gateway without any trace. Added `logAudit({ action: 'gatewayUrl_changed', detail: { old: prev.gatewayUrl, new: newUrl } })`.

**Setup wizard not audited**: The initial setup wizard (creating the first admin user and configuring providers) generated no audit events. Any operator completing setup had no verifiable timestamp for when the system was first configured. Added audit events for setup completion.

**CI health check exit code**: The CI health check script was exiting 0 even when the health endpoint returned an error status, causing CI pipelines to incorrectly report healthy deployments. Fixed to exit 1 on non-200 responses.

---

## PR #618 — `backup/restore scripts (pg_dump, Vault snapshot, MinIO mirror)`

**Commit**: *(sequential)*

### SOC2 Criteria Addressed
- **A1.2** — System availability and recovery capabilities
- **CC7.4** — Response to and recovery from security incidents
- **C1.2** — Protection of confidential data via backup integrity

### Files Changed
- `deploy/backup.sh` (new)
- `deploy/restore.sh` (new)

### What Was Fixed

**No automated backup capability**: ORION had no documented or scripted backup procedure. A database corruption or infrastructure failure would result in permanent data loss (conversations, audit logs, agent configurations, environments). Created:

- `deploy/backup.sh`: Backs up PostgreSQL via `pg_dump | gzip`, Vault via raft snapshot (`vault operator raft snapshot save`), and MinIO via `mc mirror`. Prunes backups older than 30 days automatically.
- `deploy/restore.sh`: Restores from any backup set, handling PostgreSQL restore, Vault snapshot restore, and MinIO bucket restore.

**No Vault backup**: HashiCorp Vault stores encryption keys, service credentials, and other secrets. Before this PR, a Vault failure would require manual re-sealing and re-configuration. The backup script captures a complete Vault raft snapshot that can be restored to any state.

**RPO target documented**: The backup script documents the recommended cron schedule (daily at 02:00) to achieve a 24-hour RPO.

---

## PR #619 — `rate limiting IP fix (x-forwarded-for), per-account lockout (5 attempts/15 min)`

**Commit**: *(sequential)*

### SOC2 Criteria Addressed
- **CC6.1** — Protection against credential-based attacks
- **CC6.6** — Logical access control for authentication endpoints

### Files Changed
- `apps/web/src/lib/audit.ts` — `getClientIp()` X-Forwarded-For fix
- `apps/web/src/lib/rate-limit-redis.ts` — per-account lockout implementation
- `apps/web/src/app/api/auth/` — lockout enforcement on login endpoints

### What Was Fixed

**Rate limiting IP extraction failure**: The Redis rate limiter was using `req.ip` to identify the client for per-IP rate limiting. In the Docker deployment, `req.ip` resolves to the Traefik container's internal Docker network IP (e.g. `172.17.0.2`), not the real client IP. All requests appeared to come from the same "IP", making per-IP rate limiting completely ineffective. Fixed `getClientIp()` to read `x-forwarded-for` (set by Traefik) instead.

**No per-account lockout**: The rate limiter only enforced per-IP limits. An attacker using a botnet or proxy rotation could attempt unlimited passwords against a single account by distributing requests across many IPs. Added per-account lockout: after 5 failed login attempts for a username within a sliding window, that account is locked for 15 minutes regardless of source IP. Failed attempts are tracked in Redis and logged as `user_login_failure` audit events with `reason: 'account_locked'`.

---

## PR #620 — `TOTP secrets encrypted at rest, startup migration utility`

**Commit**: *(sequential)*

### SOC2 Criteria Addressed
- **CC6.7** — Encryption of MFA credentials at rest
- **CC6.1** — Protection of MFA secrets from database exposure

### Files Changed
- `apps/web/prisma/schema.prisma` — `User.totpSecret` encryption noted
- `apps/web/src/app/api/auth/totp/` — encrypt on write, decrypt on verify
- `apps/web/src/lib/encryption-migrate.ts` (new) — startup migration utility
- Application startup hook

### What Was Fixed

**TOTP secrets stored in plaintext**: `User.totpSecret` (the Base32 TOTP shared secret) was stored unencrypted in the `users` table. A read of the `users` table — for example via a SQL injection, database backup leak, or misconfigured admin tool — would expose all TOTP secrets, allowing an attacker to generate valid TOTP codes for any enrolled user and bypass MFA entirely. Encrypted with AES-256-GCM using the same `enc:v1:` format as other secrets.

**Recovery codes not encrypted**: `User.totpRecoveryCodes` (JSON array of bcrypt-hashed recovery codes) was also stored unencrypted. While the codes themselves are bcrypt-hashed, their presence and count in plaintext aided enumeration. Encrypted as a JSON blob.

**No migration path for existing secrets**: Existing `totpSecret` values in the database were plaintext. Created `apps/web/src/lib/encryption-migrate.ts` which runs at startup, detects unencrypted `totpSecret` values (by absence of `enc:v1:` prefix), encrypts them, and logs each migration for audit purposes.

---

## PR #621 — `per-environment gateway token scoping, encrypt federation/webhook secrets, timingSafeEqual`

**Commit**: *(sequential)*

### SOC2 Criteria Addressed
- **CC6.1** — Least-privilege access for gateway services
- **CC6.7** — Encryption of gateway credentials at rest
- **CC6.6** — Timing-safe credential comparison

### Files Changed
- `apps/web/src/lib/auth.ts` — `requireGatewayAuthForEnvironment()` (new), `timingSafeEqual` fix
- `apps/web/src/lib/security/webhook-auth.ts` — `constantTimeCompare()` fix
- `apps/web/src/app/api/environments/[id]/` — per-environment token validation
- `apps/web/prisma/schema.prisma` — `Environment.gatewayToken` noted as per-environment

### What Was Fixed

**Global gateway token (token reuse across environments)**: Before this PR, all gateways authenticated using a single global `ORION_GATEWAY_TOKEN` environment variable. If one gateway was compromised, the attacker had the credentials to impersonate any gateway across any environment. Fixed by provisioning each `Environment` with its own `gatewayToken` stored (encrypted) in the database. The new `requireGatewayAuthForEnvironment(environmentId, req)` function validates that the Bearer token presented matches the token for the specific environment being accessed — not a global credential.

**`timingSafeEqual` bypass in SSO HMAC verification**: The `validateSSoHeaderHmac()` function in `auth.ts` was calling `timingSafeEqual()` but **discarding the return value** in the case where the previous-key fallback was tried:
```ts
// BUG: return value discarded, then falls through to return true
timingSafeEqual(signatureBuf, expectedPrevBuf)
return true  // ← always reached
```
This meant any SSO request with an equal-length (but incorrect) signature would pass HMAC validation — a complete authentication bypass. Fixed by capturing and returning the result of `timingSafeEqual`.

**`timingSafeEqual` bypass in webhook HMAC**: The same pattern existed in `constantTimeCompare()` in `webhook-auth.ts` — the function was using `crypto.subtle.timingSafeEqual` (which does not exist on the Web Crypto API, returns `undefined`), causing the comparison to always fall through to a plain `===` string comparison, which is vulnerable to timing oracle attacks. Fixed by routing through Node.js `crypto.timingSafeEqual`.

**Federation/webhook secrets re-encrypted per environment**: Extended the encryption of `federationToken` and `WebhookTrigger.secret` (introduced in PR #615) to ensure all existing unencrypted values in the database are detected and encrypted by the startup migration utility from PR #620.

---

## Summary Matrix

| PR | Auth | Encryption | Audit | Rate Limit | Validation | Infra |
|----|------|------------|-------|------------|------------|-------|
| #610 | CC6.1 | CC6.7 (at rest) | — | — | CC6.1 | CC6.1 |
| #611 | CC6.1 | — | CC7.2 | — | CC6.1 | — |
| #612 | CC6.1 | — | CC7.2 | — | C1.1 | — |
| #613 | CC6.3 (MFA) | — | CC7.2 | — | — | CC7.1 |
| #614 | CC6.1 (session) | — | CC7.2 | — | CC6.1 | — |
| #615 | — | CC6.7 (tokens) | — | — | — | — |
| #616 | CC6.1 (creds) | CC6.7 (TLS) | — | — | — | A1.2 |
| #617 | — | — | CC7.2 (gateway) | — | — | — |
| #618 | — | — | — | — | — | A1.2 |
| #619 | CC6.6 (lockout) | — | CC7.2 | CC6.6 | — | — |
| #620 | CC6.7 (TOTP) | CC6.7 (TOTP) | — | — | — | — |
| #621 | CC6.1 (scoping) | CC6.7 | CC7.2 | — | — | CC6.6 |

### Trust Service Criteria Legend

| Code | Criterion |
|------|-----------|
| **CC6.1** | The entity implements logical access security software, infrastructure, and architectures over protected information assets |
| **CC6.3** | The entity authorizes, modifies, or removes access to data, software, functions, and other protected information assets based on approved authorization |
| **CC6.6** | The entity implements logical access security measures to protect against threats from sources outside its system boundaries |
| **CC6.7** | The entity restricts the transmission, movement, and removal of information to authorized internal and external users and processes |
| **CC7.1** | The entity uses detection and monitoring procedures to identify changes to configurations |
| **CC7.2** | The entity monitors system components and the operation of those components for anomalies that are indicative of malicious acts |
| **CC7.4** | The entity responds to identified security incidents using a defined incident response program |
| **C1.1** | The entity identifies and maintains confidentiality commitments in its agreements with counterparties |
| **C1.2** | The entity's commitments to maintain the confidentiality of customer data are communicated |
| **A1.2** | The entity authorizes, designs, develops or acquires, implements, operates, approves, maintains, and monitors environmental protections, software, data back-up processes, and recovery infrastructure |

---

---

## PR #622 — `SOC2 auditor documentation — SECURITY.md and SOC2_HARDENING_LOG.md`

### SOC2 Criteria Addressed
- **CC4.1** — Monitoring and evaluation of controls (documented evidence)
- **CC5.2** — Communicates security commitments and responsibilities

### Files Changed
- `docs/SOC2_HARDENING_LOG.md` — this document (initial version)
- `SECURITY.md` — responsible disclosure policy, supported versions

### What Was Fixed

Created auditor-facing documentation capturing all hardening work from PRs #610–#621.

---

## PR #623 — `Business logic and cryptographic security fixes`

### SOC2 Criteria Addressed
- **CC6.1** — Logical access and ownership controls
- **CC6.6** — Protection against external threats

### Files Changed
- Various route handlers and auth helpers

### What Was Fixed

Business logic and cryptographic correctness fixes identified in Fable-model adversarial code review (batch 1).

---

## PR #624 — `Info leakage fixes — preflight auth, error sanitization, login timing, Next.js CVE`

### SOC2 Criteria Addressed
- **CC6.1** — Auth on sensitive endpoints
- **CC6.6** — Information disclosure prevention

### Files Changed
- Preflight/health endpoints, error handlers, `package.json` (Next.js version bump)

### What Was Fixed

**Preflight endpoint unauthenticated**: `/api/environments/[id]/preflight` could be called without auth, leaking k8s connectivity status. Added `requireGatewayAuthForEnvironment`.

**Error sanitization**: Stack traces were surfaced in some 500 responses. Sanitized to `e.message` only.

**Login timing oracle**: Password validation was skipped for non-existent users, enabling user enumeration via timing. Added constant-time dummy bcrypt compare when user is not found.

**Next.js CVE patch**: Upgraded Next.js to a version without the known middleware bypass vulnerability.

---

## PR #625 — `Race conditions — atomic lockout, recovery code, gateway join, federation taskId, SSO audit`

### SOC2 Criteria Addressed
- **CC6.1** — Atomic credential operations
- **CC6.6** — Concurrency safety on security-critical paths
- **CC7.2** — Audit trail completeness

### Files Changed
- `apps/web/src/lib/auth.ts` — atomic lockout, SSO audit
- `apps/web/src/app/api/environments/join/route.ts` — gateway join atomicity
- `apps/web/src/lib/totp.ts` — recovery code single-use atomicity

### What Was Fixed

**Non-atomic lockout counter**: Two concurrent failed login requests could both read `failedLoginAttempts = 4`, both increment to 5, but only trigger one lockout record. Fixed with `$transaction` + row lock.

**Recovery code TOCTOU**: `verifyRecoveryCode` and the subsequent `consumeRecoveryCode` DB write were two separate operations. A race allowed the same recovery code to be used concurrently. Fixed with a `$transaction` that reads, verifies, and consumes atomically.

**SSO audit gap**: SSO logins were not emitting `user_login` audit events. Added.

---

## PR #626 — `Fix user record exposure, suppress setup token log, add missing audit events`

### SOC2 Criteria Addressed
- **CC6.7** — Restrict transmission of sensitive fields
- **CC7.2** — Audit trail for privileged operations

### Files Changed
- `apps/web/src/app/api/admin/users/[id]/route.ts` — exclude secrets from PATCH response
- `apps/web/src/lib/setup-token.ts` — gate setup token log behind env var
- `apps/web/src/app/api/agents/route.ts` — `agent_create` audit event
- `apps/web/src/app/api/webhook-triggers/route.ts` — `webhook_trigger_create/delete` audit events
- `apps/web/src/app/api/encryption/rotate/route.ts` — `encryption_key_rotation` audit event

### What Was Fixed

**User record exposure**: Admin `PATCH /api/admin/users/[id]` returned the full updated user row including `passwordHash`, `totpSecret`, and recovery codes. Added `select` clause to strip all secret fields.

**Setup token cleartext log**: `SETUP_TOKEN` was always logged at startup. Wrapped behind `SETUP_TOKEN_SUPPRESS_LOG` / `CI` guard (full suppression). Note: token was still logged in full when not suppressed — further improved in PR #633.

**Missing audit events**: `agent_create`, `agent_delete`, `webhook_trigger_create`, `webhook_trigger_delete`, `encryption_key_rotation`, and admin `password_reset` events were defined in `audit.ts` but never emitted. All added.

---

## PR #627 — `SSRF hardening — ssrf-guard strengthening, federation/join/setup guards`

### SOC2 Criteria Addressed
- **CC6.6** — Protection against SSRF attacks on internal network resources

### Files Changed
- `apps/web/src/lib/ssrf-guard.ts` — extended block list
- `apps/web/src/lib/federation.ts` — SSRF check on spoke URLs
- `apps/web/src/app/api/environments/join/route.ts` — SSRF check on `gatewayUrl`
- `apps/web/src/app/api/setup/git-provider/route.ts`, `setup/reverse-proxy/route.ts` — canonicalized to shared `isPrivateUrl`

### What Was Fixed

**SSRF gaps in ssrf-guard**: Added CGNAT range (100.64.0.0/10), decimal/hex IP notation bypass (e.g. `http://0x7f000001`), DNS-failure-open (now blocks on resolution failure), `::ffff:0:` IPv4-mapped IPv6 alternate form, and `0.x.x.x` catch-all.

**Federation SSRF**: `fetchSpokeStatus` and `dispatchToSpoke` in `federation.ts` called user-controlled spoke URLs without SSRF validation.

**Environment join SSRF**: `gatewayUrl` accepted during join was not validated, enabling registration of a gateway pointing at an internal metadata endpoint.

**Duplicate private-host checks**: `setup/git-provider` and `setup/reverse-proxy` each had a local `isPrivateHost()` function. Removed and replaced with the canonical `isPrivateUrl` from `ssrf-guard.ts`.

---

## PR #628 — `IDOR — ownership checks on notes, scheduled-tasks, executions, tasks, agents, novas`

### SOC2 Criteria Addressed
- **CC6.3** — Authorization to access owned resources only

### Files Changed
- `apps/web/src/app/api/notes/[id]/route.ts`
- `apps/web/src/app/api/scheduled-tasks/[id]/route.ts`
- `apps/web/src/app/api/executions/[id]/route.ts`
- `apps/web/src/app/api/tasks/[id]/route.ts`
- `apps/web/src/app/api/agents/[id]/route.ts`
- `apps/web/src/app/api/novas/[id]/route.ts`
- `apps/web/src/lib/auth.ts` — `assertCanModify()` helper

### What Was Fixed

**Insecure Direct Object Reference**: GET, PUT, DELETE handlers on resource routes fetched by ID without checking whether the caller owned or was authorized to access the record. An authenticated user could enumerate and read/mutate any other user's notes, tasks, executions, and scheduled jobs. Added `assertCanModify(caller, isService, record.createdBy)` in each route; admin and service callers are exempted. Agents and Novas GET required admin (`requireAdmin()`).

---

## PR #629 — `Shell injection — domain name and stack name validation`

### SOC2 Criteria Addressed
- **CC6.6** — Input validation to prevent command injection

### Files Changed
- `apps/web/src/app/api/ingress/domains/route.ts`
- `apps/web/src/app/api/ingress/domains/[id]/route.ts`
- `apps/web/src/lib/dns-sync.ts`
- `apps/web/src/app/api/ingress/domains/[id]/dns/bootstrap/route.ts`
- `apps/web/src/lib/cluster-bootstrap.ts`

### What Was Fixed

**Domain name injection**: Domain names from user input were interpolated directly into shell commands executed via Docker/SSH. Added `DOMAIN_NAME_RE = /^[a-z0-9.-]{1,253}$/` validation at all entry points.

**Stack name/host/user injection**: `deploySwarmStack` accepted `stackName`, `host`, and `user` parameters that could contain shell metacharacters. Added allowlist regex validation on all three.

---

## PR #630 — `Webhook replay attack prevention`

### SOC2 Criteria Addressed
- **CC6.6** — Prevent replay of authenticated webhook payloads

### Files Changed
- `apps/web/src/app/api/webhooks/[triggerId]/route.ts` — delivery deduplication
- `apps/web/prisma/schema.prisma` — `WebhookDelivery` model

### What Was Fixed

**Webhook replay**: After HMAC signature verification, the same valid webhook payload could be replayed indefinitely. Added idempotency key tracking using the `X-GitHub-Delivery` header (or SHA-256 body hash fallback). A new `WebhookDelivery` Prisma model stores `(triggerId, deliveryId)` with a unique constraint; duplicate delivery returns 200 immediately without creating a new task.

---

## PR #631 — `XSS — Tabs.tsx innerHTML, MermaidBlock securityLevel`

### SOC2 Criteria Addressed
- **CC6.6** — Cross-site scripting prevention

### Files Changed
- `apps/web/src/components/notes/Tabs.tsx`
- `apps/web/src/components/notes/MermaidBlock.tsx`

### What Was Fixed

**innerHTML XSS in Tabs**: `panel.innerHTML = div.innerHTML` set raw HTML from a markdown-rendered tab, enabling script injection via crafted note content. Replaced with safe DOM cloning:
```ts
Array.from(div.childNodes).forEach(node => panel.appendChild(node.cloneNode(true)))
```

**Mermaid `securityLevel: 'loose'`**: Mermaid was configured with `loose` security, which allows inline script execution within diagram definitions. Changed to `strict`.

---

## PR #632 — `Path traversal — git clone URL, randomized tmpfile, kubectl_apply_url, sshKeyPath`

### SOC2 Criteria Addressed
- **CC6.6** — Input validation on file system and shell operations
- **CC6.1** — Least-privilege file handling

### Files Changed
- `apps/web/src/lib/cluster-bootstrap.ts` — `git clone` URL validation, `sshKeyPath` regex
- `apps/web/src/lib/tool-registry.ts` — randomized kubeconfig tmpfile
- `apps/web/src/lib/local-exec.ts` — `kubectl_apply_url` and `helm repo add` HTTPS validation

### What Was Fixed

**Git clone URL injection** (HIGH): `repoUrl` was passed directly to `git clone` without validation. A `file://` or `ssh://` URL could read local files; a flag-like string (e.g. `--upload-pack=...`) could inject git options. Fixed by validating `new URL(repoUrl).protocol` is `http:` or `https:`, and inserting `'--'` before the URL in the argv array.

**Predictable kubeconfig tmpfile** (MEDIUM): `orion-health-${env.id}.yaml` was a deterministic, never-cleaned path. An attacker with local access could pre-create a symlink to redirect the write. Fixed with `mkdtempSync` (randomized directory), `{ flag: 'wx' }` to prevent symlink follow, and `finally`-block cleanup.

**`kubectl_apply_url` SSRF** (MEDIUM): `kubectl apply -f <url>` was called with an unvalidated user-supplied URL. Fixed by requiring `https:` protocol; non-HTTPS or non-URL values return `{ error: 'Invalid or non-https URL' }`.

**`sshKeyPath` injection** (LOW): The SSH key path from environment metadata was not validated before use in SSH/SCP commands. Added `SSH_KEY_PATH_RE = /^[a-zA-Z0-9/_.-]+$/` allowlist check.

---

## PR #633 — `Auth/session, rate limiting & secrets — MFA bypass, token revocation, audit trails`

### SOC2 Criteria Addressed
- **CC6.1** — MFA enforcement, access control completeness
- **CC6.3** — Token lifecycle management (revocation)
- **CC6.6** — Rate limiting, IP spoofing prevention, body size caps
- **CC6.7** — Restrict sensitive data in responses and logs
- **CC7.2** — Complete audit trail for privileged operations

### Files Changed

**Auth / Session (CRITICAL)**
- `apps/web/src/lib/auth.ts` — MFA bypass fix, `totpEnabled`/`mfaVerified` JWT+session propagation, `user_logout` audit event
- `apps/web/src/app/api/environments/[id]/rotate-token/route.ts` — new token revocation endpoint
- `apps/web/src/middleware.ts` — gateway token blocked from all `/api/admin/*` methods (not just mutations)

**Rate Limiting (HIGH/MEDIUM)**
- `apps/web/src/middleware.ts` — webhook routes explicitly rate-limited before `PUBLIC_PATHS` early-return; per-user secondary rate limit key; added `RATE_LIMITS` for `/api/tasks`, `/api/notes`, `/api/notes/search`
- `apps/web/src/lib/rate-limit-redis.ts` — `TRUSTED_PROXY_COUNT` env var (default 1) prevents IP spoofing via leftmost `X-Forwarded-For`
- `apps/web/src/app/api/webhooks/[triggerId]/route.ts` — per-trigger rate limit (60/15 min) + 1 MB body size cap
- `apps/web/src/app/api/chat/conversations/[id]/stream/route.ts` — 1 MB body size cap

**Secrets / Info-disclosure (HIGH/MEDIUM/LOW)**
- `apps/web/src/lib/setup-token.ts` — `SETUP_TOKEN` log now truncates to first 8 chars (improves PR #626 which still logged full token)
- `apps/web/src/app/api/internal/vault/unseal-keys/route.ts` — `logAudit` on GET (`vault_unseal`) and POST (`vault_reseal`)
- `apps/web/src/app/api/health/route.ts` — unauthenticated callers receive `{ status }` only; topology gated behind auth
- `apps/web/src/app/api/environments/[id]/tools/[toolId]/approve/route.ts` + `reject/route.ts` — `tool_approve`/`tool_revoke` audit events
- `apps/web/next.config.mjs` — `poweredByHeader: false`
- `apps/web/src/app/api/environments/route.ts` — mask `federationToken` in POST 201 response
- `apps/web/src/app/api/ingress/domains/route.ts` — move domain seeding out of GET (CSRF defence-in-depth)

### What Was Fixed

**CRITICAL: MFA completely bypassable**: `authorize()` in `auth.ts` returned `{ mfaRequired: true, totpEnabled: true, username }` — a non-null object — when a user with TOTP enabled submitted no TOTP code. NextAuth treats any non-null return as a successful credential verification and mints a valid session JWT. The user received a fully authenticated session without ever providing a TOTP code. Fixed by throwing `new Error('MFA_REQUIRED')` instead, which NextAuth treats as a login failure (no JWT minted). The frontend detects the error code and redirects to the TOTP entry screen.

**CRITICAL: `totpEnabled` never propagated to JWT/session**: The enforcement gate `if (user.totpEnabled && !user.mfaVerified) throw new Error('MFA verification required')` in the session callback was dead code — `totpEnabled` was never set in the JWT, so it was always `undefined` (falsy). Fixed by propagating `totpEnabled` through the `jwt` callback and into the session, making the enforcement gate live.

**CRITICAL: No gateway token revocation**: `mcga_*` environment gateway tokens had no rotation or revocation path. A leaked token was permanently valid. Added `POST /api/environments/[id]/rotate-token` (admin-gated, audit-logged) that generates a new `mcga_` + 32 random bytes token, writes it to the DB (immediately invalidating the old one), and returns the new token once.

**HIGH: Gateway token reads admin routes**: The middleware denied the global `ORION_GATEWAY_TOKEN` on admin _mutations_ (PUT/POST/PATCH/DELETE) but allowed it on admin _reads_ (GET). A leaked token could enumerate all users, read system config, etc. Extended the denylist to cover all HTTP methods on `/api/admin/*`.

**HIGH: Webhook rate limit dead code**: The `RATE_LIMITS['/api/webhooks']` entry was unreachable — `applyRateLimit()` is only called outside `PUBLIC_PATHS`, but `/api/webhooks` is in `PUBLIC_PATHS`. A single compromised webhook secret enabled unlimited task creation, each consuming LLM tokens. Fixed by applying the rate limit before the `PUBLIC_PATHS` early-return and adding an in-handler per-trigger limit.

**HIGH: IP spoofing defeats rate limiting**: `getClientIpForRateLimit` took the leftmost `X-Forwarded-For` value, which is attacker-controlled. An attacker could rotate a fake IP header to get a fresh rate-limit bucket on every request, defeating all IP-based limits (including `/api/login`). Fixed with `TRUSTED_PROXY_COUNT` (default 1): takes the Nth-from-right value, which was set by the trusted proxy and cannot be spoofed.

**HIGH: Vault unseal-key operations not audited**: GET `/api/internal/vault/unseal-keys` returns decrypted Vault unseal keys — described in-code as "the most sensitive secret in the system." POST overwrites them. Neither operation was audited. Added `logAudit` for both, using the `vault_unseal` and `vault_reseal` actions defined in `audit.ts`.

**MEDIUM: `/api/health` discloses internal topology**: Unauthenticated callers received full system topology: external model names, k8s reachability, DB health, worker queue depths (`running`/`queued`). Now returns `{ status: 'ok' | 'degraded' }` only; full details gated behind authentication.

**LOW: `SETUP_TOKEN` still logged in full when not suppressed**: PR #626 added a `SETUP_TOKEN_SUPPRESS_LOG` guard but logged the complete token when the guard was not set. This PR truncates to `token.slice(0,8)...[redacted]` — the critical identifying prefix for grep/bootstrap purposes is preserved while the secret entropy is withheld.

---

## Adversarial Review Programme (2026-06-13)

In addition to the incremental PRs above, six dedicated adversarial code reviews were conducted by Opus-4 targeting attack surfaces not covered by the standard hardening pass:

| Review | Verdict | Outcome |
|--------|---------|---------|
| Cryptography (IV reuse, key derivation, plaintext fallback) | **SOUND** — no fixable findings | No PR needed |
| Auth/Session (MFA bypass, JWT tampering, middleware gaps) | **CRITICAL findings** | Fixed in PR #633 |
| Path traversal (git clone, tmpfile, kubectl URL, sshKeyPath) | **HIGH/MEDIUM findings** | Fixed in PR #632 |
| Rate limiting / DoS (webhook spam, embedding amplification) | **HIGH/MEDIUM findings** | Fixed in PR #633 |
| Secrets/info-disclosure (tokens in logs, error messages) | **HIGH/MEDIUM findings** | Fixed in PR #633 |
| CSRF (state-changing GETs, origin validation) | **LOW finding only** | Fixed in PR #633 |

### Crypto audit summary (no PR)
AES-256-GCM implementation confirmed sound: fresh `randomBytes(12)` IV per call, correct PBKDF2-based key derivation, all token comparisons use `timingSafeEqual`, all tokens generated with CSPRNG. Two informational findings (intentional setup-token log — improved in PR #633; legacy plaintext passthrough during migration window — by design).

### CSRF audit summary
Strong baseline: `SameSite=Strict` session cookie is the dominant CSRF control; `form-action 'self'` CSP; all webhook routes authenticated by HMAC (not cookies). Single LOW finding (domain seeding in GET handler) fixed in PR #633. No HIGH/MEDIUM CSRF vulnerabilities confirmed.

---

## Summary Matrix

| PR | Auth | Encryption | Audit | Rate Limit | Validation | Infra |
|----|------|------------|-------|------------|------------|-------|
| #610 | CC6.1 | CC6.7 | — | — | CC6.1 | CC6.1 |
| #611 | CC6.1 | — | CC7.2 | — | CC6.1 | — |
| #612 | CC6.1 | — | CC7.2 | — | C1.1 | — |
| #613 | CC6.3 | — | CC7.2 | — | — | CC7.1 |
| #614 | CC6.1 | — | CC7.2 | — | CC6.1 | — |
| #615 | — | CC6.7 | — | — | — | — |
| #616 | CC6.1 | CC6.7 | — | — | — | A1.2 |
| #617 | — | — | CC7.2 | — | — | — |
| #618 | — | — | — | — | — | A1.2 |
| #619 | CC6.6 | — | CC7.2 | CC6.6 | — | — |
| #620 | CC6.7 | CC6.7 | — | — | — | — |
| #621 | CC6.1 | CC6.7 | CC7.2 | — | — | CC6.6 |
| #622 | — | — | — | — | — | — |
| #623 | CC6.1 | CC6.6 | — | — | — | — |
| #624 | CC6.1 | — | — | — | C1.1 | — |
| #625 | CC6.1 | — | CC7.2 | — | — | — |
| #626 | CC6.7 | — | CC7.2 | — | — | — |
| #627 | — | — | — | — | CC6.6 | — |
| #628 | CC6.3 | — | — | — | — | — |
| #629 | — | — | — | — | CC6.6 | — |
| #630 | CC6.6 | — | — | — | — | — |
| #631 | — | — | — | — | CC6.6 | — |
| #632 | — | — | — | — | CC6.6 | CC6.1 |
| #633 | CC6.1/CC6.3 | — | CC7.2 | CC6.6 | CC6.7 | — |

### Trust Service Criteria Legend

| Code | Criterion |
|------|-----------|
| **CC6.1** | The entity implements logical access security software, infrastructure, and architectures over protected information assets |
| **CC6.3** | The entity authorizes, modifies, or removes access to data, software, functions, and other protected information assets based on approved authorization |
| **CC6.6** | The entity implements logical access security measures to protect against threats from sources outside its system boundaries |
| **CC6.7** | The entity restricts the transmission, movement, and removal of information to authorized internal and external users and processes |
| **CC7.1** | The entity uses detection and monitoring procedures to identify changes to configurations |
| **CC7.2** | The entity monitors system components and the operation of those components for anomalies that are indicative of malicious acts |
| **CC7.4** | The entity responds to identified security incidents using a defined incident response program |
| **C1.1** | The entity identifies and maintains confidentiality commitments in its agreements with counterparties |
| **C1.2** | The entity's commitments to maintain the confidentiality of customer data are communicated |
| **A1.2** | The entity authorizes, designs, develops or acquires, implements, operates, approves, maintains, and monitors environmental protections, software, data back-up processes, and recovery infrastructure |

---

*This log was compiled from `git log --oneline` output and source code inspection as of 2026-06-13.*
*Each PR commit SHA can be verified with `git show <sha>` in the ORION repository.*
