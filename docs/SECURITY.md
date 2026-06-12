# ORION Security Controls Documentation

> **Audience**: SOC2 auditors, security reviewers, and compliance teams.
> All claims reference specific source files so they can be independently verified.
> Last updated: 2026-06-12 (reflects PRs #610–#621).

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Authorization](#2-authorization)
3. [Encryption at Rest](#3-encryption-at-rest)
4. [Encryption in Transit](#4-encryption-in-transit)
5. [Audit Logging](#5-audit-logging)
6. [Rate Limiting and Account Lockout](#6-rate-limiting-and-account-lockout)
7. [Input Validation](#7-input-validation)
8. [Infrastructure Security](#8-infrastructure-security)
9. [Backup and Recovery](#9-backup-and-recovery)
10. [Webhook Security](#10-webhook-security)
11. [API Key Security](#11-api-key-security)

---

## 1. Authentication

**Source file**: `apps/web/src/lib/auth.ts`

### Strategy

ORION uses NextAuth.js configured with the **JWT session strategy** (`session: { strategy: 'jwt' }`). Sessions are never stored in the database; the entire session state is carried in a signed, `httpOnly` cookie.

### Session Configuration

| Parameter | Value | Notes |
|-----------|-------|-------|
| `session.strategy` | `'jwt'` | Stateless JWT — no server-side session store |
| `session maxAge` | 8 hours (28,800 s) | Configured in `authOptions` (PR #614) |
| Cookie `httpOnly` | `true` | JavaScript cannot read the session cookie |
| Cookie `sameSite` | `'strict'` | Prevents CSRF via cross-origin requests |
| Cookie `secure` | `true` in production | Set when `NODE_ENV=production` or `HEADER_X_FORWARDED_PROTO=https` |
| Cookie name (prod) | `__Secure-next-auth.session-token` | `__Secure-` prefix enforces HTTPS transport |
| CSRF token cookie | `__Host-next-auth.csrf-token` (prod) | `__Host-` prefix binds cookie to exact origin |

The `IS_SECURE` flag is derived at module load time:
```ts
const IS_SECURE = process.env.NODE_ENV === 'production'
               || process.env.HEADER_X_FORWARDED_PROTO === 'https'
```

### Credential Flow

1. User submits `username` + `password` (and optionally `totpCode`).
2. `CredentialsProvider.authorize()` fetches the user row via `prisma.user.findUnique()`, selecting only fields needed for auth (no over-fetching).
3. Password is verified with `bcryptjs.compare()` against `User.passwordHash`.
4. If the user has `totpEnabled: true`, the TOTP or recovery-code path is taken (see §1 MFA below).
5. On success, `User.lastSeen` is updated and a `user_login` audit event is emitted.
6. On failure, a `user_login_failure` audit event is emitted with a `reason` field (`invalid_password`, `invalid_totp`, `invalid_recovery_code`).

The JWT callback re-fetches the user on every subsequent request to detect deactivated accounts:
```ts
if (!dbUser || !dbUser.active) {
  token.sub = undefined  // invalidates the token
}
```
Roles are also re-synced from the database on every request so that demoted admins lose access immediately without needing to log out.

### Multi-Factor Authentication (TOTP) — SOC2 [M-002]

**Source file**: `apps/web/src/lib/totp.ts`

- ORION implements RFC 6238 TOTP using the `otplib` library with HMAC-SHA1, 30-second time steps, and 6-digit codes.
- Compatible with Google Authenticator, Authy, 1Password, and all standard TOTP apps.
- QR code enrollment URLs are generated with proper URI encoding of username and issuer to prevent `otpauth://` parameter injection.
- TOTP secrets are 20-byte (160-bit) Base32-encoded values.
- **Recovery codes**: 8 unique 8-character alphanumeric codes are generated per enrollment. Each is individually bcrypt-hashed (cost 14) and stored as a JSON array in `User.totpRecoveryCodes`. Recovery codes are **single-use**: `consumeRecoveryCode()` removes the matching code from the stored set on use.
- Admin `requireAdmin()` enforces that users with `totpEnabled=true` must also have `mfaVerified=true` in their session token (PR #613).
- MFA verified state in the JWT carries a `mfaVerifiedAt` timestamp; verification expires after 15 minutes (`token.mfaVerifiedAt > 15 * 60 * 1000`).

**Schema fields** (`apps/web/prisma/schema.prisma`, `User` model):
```
totpSecret            String?   // Base32 TOTP secret (encrypted at rest — PR #620)
totpEnabled           Boolean   @default(false)
totpRecoveryCodes     String?   // JSON array of bcrypt-hashed recovery codes
totpEnabledAt         DateTime? // When MFA was enabled (audit trail)
```

### SSO / Authentik Integration — SOC2 [SSO-001]

**Source file**: `apps/web/src/lib/auth.ts` → `validateSSoHeaderHmac()`

ORION supports header-based SSO via Authentik (or any reverse proxy that forwards `x-authentik-*` headers). Header mode is enabled via `OIDCProvider.headerMode`.

**HMAC signature validation** prevents header injection attacks if the reverse proxy is compromised:

- The reverse proxy signs a canonical string `username|email|name|uid|timestamp` with HMAC-SHA256 using a shared secret (`SSO_HMAC_SECRET`).
- Signature is passed in the `x-authentik-hmac` header.
- ORION validates the timestamp is within a 30-second window (rejects requests older than 30 s or more than 5 s in the future).
- Comparison is done with `crypto.timingSafeEqual()` to prevent timing attacks.
- If `SSO_HMAC_SECRET` is not configured and `SSO_ALLOW_UNSIGNED_SSO` is not explicitly `true`, all SSO header requests are rejected.
- Key rotation is supported via `SSO_HMAC_SECRET_PREVIOUS` — allows zero-downtime rotation of the HMAC secret.
- Failed HMAC validation is logged as `user_login_failure` with `reason: 'invalid_hmac'`.

---

## 2. Authorization

**Source files**: `apps/web/src/lib/auth.ts`, `apps/web/prisma/schema.prisma`

### Role Model

ORION uses a three-tier role model stored in `User.role`:

| Role | Permissions |
|------|-------------|
| `admin` | Full access to all resources; can create users, API keys, manage environments; bypasses all tier checks; requires MFA if enabled |
| `user` | Standard access; can create tasks, use tools within their assigned tier; cannot manage other users |
| `readonly` | Read-only access to resources; cannot create or modify records |

### Core Authorization Functions

**`getCurrentUser()`** — Primary authentication resolver:
1. Calls `getServerSession(authOptions)` to validate the JWT cookie.
2. Falls back to SSO header auth if `OIDCProvider.headerMode` is enabled (validates HMAC — see §1).
3. Returns `null` if neither path is authenticated.
4. Returns `AppUser` with `role`, `active`, `totpEnabled`, and `mfaVerified` fields.

**`requireAdmin()`** — Used on all admin-only API routes:
```ts
export async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') throw new Error('Unauthorized')
  if (user.totpEnabled && !user.mfaVerified) throw new Error('MFA verification required')
  return user
}
```

**`requireServiceAuth()`** — Allows either a logged-in user session or a gateway service token. Uses `timingSafeEqual` for token comparison to prevent timing attacks.

**`assertCanModify()`** — Resource-level authorization: allows admins, record creators, and the gateway service.

### Per-Environment Token Scoping — SOC2 [ENV-001] (PR #621)

Each `Environment` record stores its own `gatewayToken` field. The function `requireGatewayAuthForEnvironment(environmentId, req)` validates that the Bearer token presented by a gateway matches the token stored for that specific environment — not a global shared token. This prevents a compromised gateway from accessing resources belonging to other environments.

### Tool Group Tier System

Tool access is controlled by a three-tier system per environment:

| Tier | Description |
|------|-------------|
| `viewer` | Can trigger ungrouped tools and viewer-tier tool groups |
| `operator` | Can additionally trigger operator-tier tool groups |
| `admin` | Full tool access within the environment |

- Tool group minimum tiers are stored in `ToolGroup.minimumTier`.
- Per-user environment tiers are stored in `EnvironmentUserTier`.
- Users with `role=admin` bypass all tier checks.
- `ToolAgentRestriction` records allow locking specific tools to specific agents only.

---

## 3. Encryption at Rest

**Source file**: `apps/web/src/lib/encryption.ts`

### Algorithm

All sensitive values are encrypted using **AES-256-GCM** (authenticated encryption providing both confidentiality and integrity):

```
Algorithm : AES-256-GCM
Key size  : 256 bits (32 bytes)
IV size   : 96 bits (12 bytes) — randomly generated per encryption
Auth tag  : 128 bits (16 bytes)
```

### Stored Format

Encrypted values use the `enc:v1:` prefix to distinguish them from legacy plaintext values:

```
enc:v1:<base64(12-byte IV || 16-byte GCM auth tag || ciphertext)>
```

- The GCM authentication tag prevents ciphertext tampering — decryption will fail if the ciphertext is modified.
- A new random IV is generated for every encryption operation (preventing IV reuse, which would be catastrophic for GCM security).

### Key Management

- The encryption key is a 32-byte random value, base64-encoded, stored in the `ORION_ENCRYPTION_KEY` environment variable.
- Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- If the key is not set or is not exactly 32 bytes, all encrypt/decrypt operations throw immediately — there is no silent fallback to plaintext.
- `decryptJsonStrict()` provides a strict variant that throws (rather than silently passing through) if a value lacks the `enc:v1:` prefix, preventing substitution attacks where an attacker writes unencrypted plaintext to the database.

### Key Rotation

The functions `encryptWithKey()` and `decryptWithKey()` accept an explicit key parameter, enabling rotation workflows:

1. Admin calls the key rotation API endpoint (PR #615).
2. The endpoint re-encrypts all sensitive fields using the new key.
3. `ORION_ENCRYPTION_KEY` is updated in the environment.

### Encrypted Fields

The following database fields are encrypted at rest:

| Model | Field | Encrypted Since |
|-------|-------|-----------------|
| `Environment` | `gatewayToken` | PR #615 |
| `Environment` | `kubeconfig` | PR #610 |
| `Environment` | `federationToken` | PR #615 / #621 |
| `WebhookTrigger` | `secret` | PR #615 |
| `SystemSetting` | Sensitive values (e.g. API keys, git tokens) | PR #610 |
| `User` | `totpSecret` (Base32 TOTP secret) | PR #620 |
| `User` | `totpRecoveryCodes` (JSON array of bcrypt hashes) | PR #620 |

### Backward Compatibility

The `decrypt()` and `decryptJson()` functions pass through values that lack the `enc:v1:` prefix with a console warning, enabling gradual migration of pre-encryption data. The strict `decryptJsonStrict()` variant should be used for high-value secrets where silent passthrough is not acceptable.

---

## 4. Encryption in Transit

### HTTPS Enforcement

- All external federation traffic is required to use HTTPS (enforced in PR #616).
- The federation client validates that spoke URLs and hub URLs begin with `https://` before making any outbound requests.
- TLS termination is handled by Traefik (the bundled reverse proxy) using Let's Encrypt certificates via cert-manager.

### Internal Service Communication

- Redis connections use password authentication via `REDIS_PASSWORD`.
- Vault communication uses token-based authentication over TLS.
- MinIO connections use access key / secret key authentication.
- Gateway-to-web communication uses per-environment Bearer tokens (see §2 Per-Environment Token Scoping).

### Cookie Security

As documented in §1, session cookies use `Secure`, `HttpOnly`, `SameSite=Strict` attributes in production, ensuring cookies are only transmitted over HTTPS and cannot be accessed by JavaScript or sent cross-origin.

---

## 5. Audit Logging

**Source files**: `apps/web/src/lib/audit.ts`, `apps/web/src/lib/audit-export.ts`

### Overview

ORION maintains a tamper-evident audit log for all security-relevant events. The log is stored in the `AuditLog` PostgreSQL table and archived to S3-compatible storage (MinIO) with Object Lock COMPLIANCE mode.

### `logAudit()` Function

```ts
logAudit({
  userId: string,       // ID of the acting user (or 'ANONYMOUS' for pre-auth events)
  action: AuditAction,  // see event types below
  target: string,       // resource affected (user ID, environment ID, etc.)
  detail?: Record<string, unknown>,  // additional context
  ipAddress?: string,   // extracted from X-Forwarded-For header
  userAgent?: string,   // HTTP User-Agent header
})
```

- Non-blocking: audit failures are caught and logged to `console.error` without affecting the request. Audit logging must never impact normal operations.
- IP extraction respects `x-forwarded-for` headers (set by Traefik / reverse proxies) via `getClientIp()`.

### Audited Event Types

| Action | Trigger |
|--------|---------|
| `user_login` | Successful credential or SSO login |
| `user_login_failure` | Failed password, TOTP, recovery code, or SSO HMAC check |
| `user_logout` | Explicit logout |
| `user_create` | Admin creates a new user |
| `user_update` | User profile updated |
| `user_delete` | User account deleted |
| `user_role_change` | User role changed |
| `mfa_enable` | User enables TOTP |
| `mfa_disable` | User disables TOTP |
| `mfa_verify_success` | Successful TOTP code verification |
| `mfa_verify_failure` | Failed TOTP or recovery code attempt |
| `api_key_create` | API key created |
| `api_key_revoke` | API key revoked |
| `environment_create` | Environment provisioned |
| `environment_update` | Environment configuration changed |
| `environment_delete` | Environment deleted |
| `gateway_joined` | Gateway joined an environment (PR #617) |
| `gatewayUrl_changed` | Gateway URL changed (PR #617) |
| `sso_config_update` | SSO configuration changed (PR #613) |
| `admin_action` | Generic admin operation |
| `settings_update` | System setting changed |
| `vault_unseal` | Vault unsealed |
| `vault_reseal` | Vault re-sealed |
| `tool_execute` | Tool executed by an agent |
| `tool_approve` | Tool execution approved by admin |
| `tool_revoke` | Tool access revoked |

### Hash Chain (Tamper Evidence)

Each `AuditLog` row includes a `previousHash` field:

```ts
previousHash: SHA-256(JSON.stringify({
  id, userId, action, target, detail,
  ipAddress, userAgent, createdAt, previousHash
}))
```

This creates a forward-linked hash chain. Modifying any past entry invalidates all subsequent `previousHash` values, making tampering detectable.

**Schema** (`apps/web/prisma/schema.prisma`):
```prisma
model AuditLog {
  id           String   @id @default(cuid())
  userId       String
  action       String
  target       String
  detail       Json?
  ipAddress    String?      // SOC2: [M-005] Source IP for audit trail
  userAgent    String?      // SOC2: [M-005] Client user-agent
  createdAt    DateTime @default(now())
  previousHash String?      // SOC2: [M-005] Hash chain for tamper-evidence

  @@index([userId])
  @@index([createdAt])
  @@index([userId, createdAt])
  @@index([ipAddress])
}
```

### S3 Archive with Object Lock — SOC2 [L-001]

**Source file**: `apps/web/src/lib/audit-export.ts`

Audit logs are periodically exported to S3-compatible storage (MinIO) with:

- **Format**: Gzip-compressed JSON (`audit-logs-YYYY-MM-DD.json.gz`)
- **Server-side encryption**: `ServerSideEncryption: 'AES256'`
- **Object Lock**: `ObjectLockMode: 'COMPLIANCE'` with a 1-year retention period — objects cannot be deleted or overwritten even by administrators
- **Retention window**: Configurable via `AUDIT_EXPORT_RETENTION_DAYS` env var; minimum 90 days, maximum 2555 days; defaults to 365 days
- **Manifest**: A companion `manifest-YYYY-MM-DD.json` file is uploaded with each export containing SHA-256 checksums, record count, date range, and hash chain metadata
- **Hash chain across exports**: Each manifest includes a `hashChain.previousManifest` hash linking to the previous manifest, extending the tamper-evidence chain across export batches
- **Safe delete**: Logs are deleted from the database by exact row ID (not re-queried time window), preventing accidental deletion of rows written after the export started

---

## 6. Rate Limiting and Account Lockout

**Source file**: `apps/web/src/lib/rate-limit-redis.ts`

### Redis-Backed Rate Limiting

ORION uses a **Redis sliding window rate limiter** (SOC2 [M-003]):

- **Data structure**: Redis sorted set per key — timestamps as members scored by Unix epoch (ms)
- **Algorithm**: Atomic Lua script evicts expired entries, counts remaining capacity, and records new requests in a single round-trip
- **TTL**: Each sorted set has a TTL of `2 × window_ms` for automatic cleanup
- **Member uniqueness**: Uses a monotonically incrementing Redis counter (`INCR`) per key to generate unique members, preventing collision under concurrent load (safe for Redis replication)
- **Fallback**: Falls back to in-memory Map if Redis is unavailable; in-memory state is cleared when Redis reconnects to prevent double-counting

**Connection support**:
- Standard Redis via `REDIS_URL`
- Upstash Redis via `UPSTASH_REDIS_URL`
- Redis Sentinel via `REDIS_SENTINEL_MASTER` + `REDIS_SENTINEL_NODES` + optional `REDIS_SENTINEL_PASSWORD`
- Password auth via `REDIS_PASSWORD`

### IP Extraction Fix (PR #619)

The rate limiter correctly extracts the real client IP by reading the `x-forwarded-for` header:

```ts
// getClientIp() in audit.ts
const forwarded = req.headers.get('x-forwarded-for')
if (forwarded) return forwarded.split(',')[0].trim()
```

Traefik (the bundled reverse proxy) populates `x-forwarded-for` with the real client IP. Before PR #619, the `req.ip` property was used, which returns the Traefik container IP on the Docker network (not the client IP), making per-IP rate limiting ineffective.

### Per-Account Lockout (PR #619)

ORION enforces a **per-account lockout policy**:

- **Threshold**: 5 failed login attempts
- **Lockout duration**: 15 minutes
- **Scope**: Per `username` (account-based, not IP-based) — prevents distributed brute force that routes through different IPs
- Failed attempts are tracked in Redis with the same sliding window mechanism
- Lockout state is also logged as `user_login_failure` audit events

---

## 7. Input Validation

**Source file**: `apps/web/src/lib/validate.ts`

### Framework

All API route inputs are validated using **Zod** schemas before being passed to database operations. The `parseBodyOrError()` helper returns structured error details (field path + message) on validation failure.

### Key Schemas

| Schema | Key Constraints |
|--------|----------------|
| `CreateUserSchema` | `username`: 3–100 chars, alphanumeric/hyphens/underscores; `email`: valid email; `password`: min 8 chars; `role`: enum `admin/user/readonly` |
| `SetupAdminSchema` | `username`: 3–100 chars, alphanumeric; `password`: min 10 chars |
| `CreateEnvironmentSchema` | `name`: DNS label regex (lowercase alphanumeric + hyphens, 1–100 chars); `gatewayUrl`: valid URL |
| `CreateAgentSchema` | `name`: no control characters (`/^[^\x00-\x1f\x7f]+$/`) — prevents LLM prompt injection via agent names |
| `TOTPVerifySchema` | TOTP code: exactly 6 digits (`/^\d+$/`) |
| `CreateWebhookTriggerSchema` | `name` max 200, `taskTitle` max 500, `taskDesc` max 5000 |
| `CreateApiKeySchema` | `name` max 200, `scopes` max 20 items |

**Note on password minimum length**: The `CreateUserSchema` uses `min(8)` for passwords created by admins on behalf of users; the setup wizard (`SetupAdminSchema`) uses `min(10)`. PR #614 documents the 12-character guidance in operational policy. The `sanitizeTitle()` helper strips `<>` angle brackets and null bytes from strings interpolated into system prompts.

### Injection Prevention

- **SQL injection**: All database queries use Prisma ORM parameterized queries. Raw SQL queries (`$queryRawUnsafe`) in `api-key.ts` use positional `$1`/`$2` parameters.
- **Prompt injection via agent names**: `CreateAgentSchema` forbids control characters, preventing newline injection into LLM system prompts (identified in PR #611).
- **Federation task injection**: Task descriptions received from spoke environments are sanitized before being passed to the worker (PR #611).
- **SSRF**: `ssrf-guard.ts` validates gateway URLs and webhook URLs against a block list of RFC 1918 / loopback / link-local addresses.

### Sensitive Data Redaction

**Source file**: `apps/web/src/lib/redact.ts`

- `wrapConsoleLog()` wraps all `console.*` methods globally at startup, applying `redactSensitive()` to all output (SOC2 [K8S-001]).
- Patterns matched for redaction: `orion_ak_*` API keys, Bearer tokens, JWT tokens, `mcg_*` gateway join tokens, key=value pairs for `password`, `token`, `secret`, `apiKey`, `kubeconfig`, `gatewayToken`, known secret env vars.
- `redactObjectFields()` and `redactNestedFields()` strip specific field names from objects before logging or returning API responses.

---

## 8. Infrastructure Security

### Auto-Generated MinIO and Redis Credentials (PR #616)

**Source**: `deploy/bootstrap.sh`

During initial deployment, the bootstrap script auto-generates cryptographically random credentials for:
- MinIO root user and password
- Redis password
- Vault unseal keys

These are written to `deploy/.env` (which is gitignored) and never committed to source control.

### Startup Environment Validation (PR #616)

At application startup, ORION validates that all required environment variables are present and correctly formatted:
- `ORION_ENCRYPTION_KEY` — must decode to exactly 32 bytes
- `NEXTAUTH_SECRET` — must be set
- `DATABASE_URL` — must be set
- Redis / MinIO connection validation

If any required variable is missing or malformed, the application exits with a clear error message rather than starting in a degraded state.

### Startup Encryption Migration Utility (PR #620)

A migration utility runs on startup to detect and encrypt any plaintext values in the database that should be encrypted (e.g., legacy `totpSecret` values from before PR #620). The utility uses `encrypt()` from `encryption.ts` and logs all fields it migrates for audit purposes.

### SSO Startup Alarm (PR #613)

If `SSO_HMAC_SECRET` is not configured but `OIDCProvider.headerMode` is enabled, ORION logs a startup alarm warning that SSO header auth will reject all requests unless `SSO_ALLOW_UNSIGNED_SSO=true` is explicitly set. This prevents silent misconfiguration.

### Image Digest Pinning

Docker images in `deploy/docker-compose.yml` reference specific digest-pinned tags for production deployments, preventing unintended image updates from breaking the deployment or introducing supply chain vulnerabilities.

---

## 9. Backup and Recovery

**Source files**: `deploy/backup.sh`, `deploy/restore.sh`

### Backup Script (`deploy/backup.sh`)

The backup script covers all three persistent data stores:

1. **PostgreSQL**: `pg_dump` → gzip-compressed `.sql.gz` file
   ```
   $COMPOSE exec -T postgres pg_dump -U orion orion | gzip > backups/postgres_YYYYMMDD_HHMMSS.sql.gz
   ```

2. **Vault**: Raft snapshot (`vault operator raft snapshot save`) — captures the full Vault state including all KV secrets, policies, and auth methods

3. **MinIO**: `mc mirror` — mirrors all MinIO buckets (including audit log archives) to a local backup directory

### Retention Policy

Backup files older than **30 days** are automatically pruned:
```bash
find "$BACKUP_DIR" -name "postgres_*.sql.gz" -mtime +30 -delete
find "$BACKUP_DIR" -name "vault_*.snap"      -mtime +30 -delete
```

**Recommended RPO**: Run daily via cron:
```cron
0 2 * * * /opt/orion/deploy/backup.sh >> /var/log/orion-backup.log 2>&1
```

### Recovery Script (`deploy/restore.sh`)

The restore script restores from any backup set:
1. Stops running containers
2. Restores PostgreSQL from the `.sql.gz` dump
3. Restores Vault from the raft snapshot
4. Optionally restores MinIO buckets

### Audit Log Long-Term Retention

In addition to the backup scripts, audit logs are independently archived to MinIO via `exportAuditLogs()` (see §5) with Object Lock COMPLIANCE mode, ensuring audit logs cannot be deleted within the 1-year Object Lock retention window even if the primary PostgreSQL database is lost.

---

## 10. Webhook Security

**Source file**: `apps/web/src/lib/security/webhook-auth.ts`

### Signature Verification

ORION supports multiple webhook authentication schemes depending on the source:

| Source | Scheme | Header |
|--------|--------|--------|
| GitHub | HMAC-SHA256 | `X-Hub-Signature-256: sha256=<hex>` |
| Prometheus/AlertManager | X-Webhook-Secret | `X-Webhook-Secret: <secret>` |
| CrowdSec, Wazuh | HMAC-SHA256 | `X-Signature: sha256=<hex>` |
| Custom / generic | Bearer token or HMAC | `Authorization: Bearer <token>` |

All HMAC comparisons use `timingSafeEqual()` (via `constantTimeCompare()`):
```ts
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  return timingSafeEqual(bufA, bufB)
}
```

The `timingSafeEqual` path was previously broken (incorrectly called `crypto.subtle.timingSafeEqual` which does not exist, causing the comparison to always return `true`). Fixed in PR #621.

### Replay Protection

- Requests include an `X-Timestamp` header (ISO 8601 or Unix epoch).
- ORION rejects requests where `|now - timestamp| > 300 seconds` (5-minute replay window).
- In production (`NODE_ENV=production` or `WEBHOOK_REQUIRE_TIMESTAMP=true`), requests missing the timestamp header are rejected with 401.

### Idempotency

- Events are deduplicated using `SecurityEvent.dedupKey` (SHA-256 of the event payload).
- Duplicate events within a 24-hour window are silently discarded without creating a new `SecurityEvent` row.
- This protects against retry storms from upstream senders (CrowdSec, Wazuh).

### Body Size Guard

- Maximum webhook body size: **1 MiB** (`WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024`)
- Requests with `Content-Length > 1 MiB` are rejected with 413 before the body is read, bounding CPU and memory cost of unauthenticated requests.
- In production, requests missing `Content-Length` are rejected with 411.

### Secrets Encrypted at Rest (PR #615)

`WebhookTrigger.secret` is encrypted using AES-256-GCM (see §3) before being written to the database. The secret is decrypted only at the time of signature verification.

### Misconfiguration Guards

- If a webhook endpoint is deployed without a configured secret, `warnMissingWebhookSecret()` logs a loud warning.
- In production, requests to an unconfigured webhook endpoint return HTTP 500 rather than accepting unauthenticated payloads.
- Dev mode acceptance (no-secret) requires both `NODE_ENV !== 'production'` AND `WEBHOOK_DEV_MODE=true` — preventing staging environments that forget to set `NODE_ENV` from silently accepting unauthenticated payloads.

---

## 11. API Key Security

**Source file**: `apps/web/src/lib/api-key.ts`

### Key Format

API keys have the format `orion_ak_<36 hex chars>` (144 bits of entropy from `crypto.randomBytes(18)`).

### Storage

API keys are **never stored in plaintext**. Only a bcrypt hash (cost factor 14) is stored:

```ts
const hashValue = await hash(raw, 14)  // bcryptjs, cost 14
```

### Lookup Strategy

bcrypt is non-deterministic (different salt each call), so a deterministic prefix is used for indexed database lookup:

```ts
function deterministicPrefix(raw: string): string {
  return raw.slice(9, 25)  // 16 chars of the random hex portion (64 bits)
}
```

1. The 16-character deterministic prefix is used to narrow the lookup to a small candidate set.
2. `bcrypt.compare()` verifies the full key against the stored hash.

This avoids using a fast hash function (SHA-256) on a secret for lookup, satisfying the CodeQL `js/insufficient-password-hash` rule while enabling efficient indexed queries.

### Access Controls

- Only users with `role=admin` can create API keys (`requireAdmin()` is called on `POST /api/api-keys`).
- API keys carry the permissions of the owning user.
- Keys can be revoked by the owning user or an admin (`revokeApiKey()` uses Prisma ORM, not raw SQL).
- `lastUsedAt` is updated on every successful verification for audit purposes.
- Key expiration is supported (`ApiKey.expiresAt`); expired keys are rejected at the verification step.
- All key creation and revocation events are logged via `logAudit()` with `api_key_create` / `api_key_revoke` actions.

### Key Visibility

The plaintext key is returned only once at creation time and never stored. The API response for `GET /api/api-keys` returns only `id`, `hashPrefix`, `name`, `active`, `expiresAt`, `lastUsedAt`, and `createdAt` — never the hash or any derivable secret.

---

*This document was generated from source code inspection as of commit `db7131d` (PR #613). Auditors should verify each cited source file against the current codebase.*
