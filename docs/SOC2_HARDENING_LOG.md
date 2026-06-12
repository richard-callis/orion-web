# SOC2 Hardening Log — ORION (PRs #610–#621)

> **Audience**: SOC2 auditors verifying the ORION hardening programme.
> This document provides a chronological log of all security improvements made across PRs #610 through #621,
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

*This log was compiled from `git log --oneline` output and source code inspection as of 2026-06-12.*
*Each PR commit SHA can be verified with `git show <sha>` in the ORION repository.*
