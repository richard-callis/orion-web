/**
 * Audit logging utility for SOC2 [M-005] compliance.
 *
 * Creates audit log entries with IP address and user-agent tracking.
 * Non-blocking — failures are silently logged to prevent impact on request processing.
 *
 * Hash chain for tamper-evidence: each entry's `previousHash` is HMAC-SHA-256
 * (when ORION_AUDIT_HMAC_KEY is set) or unkeyed SHA-256 of
 * (previous entry's action + timestamp + detail + previousHash).
 * This allows verification that the log has not been modified.
 *
 * IMPORTANT: Key rotation (changing ORION_AUDIT_HMAC_KEY) destroys the hash chain —
 * entries before and after the rotation will not verify as a continuous chain.
 * Record the rotation event and chain-start marker before rotating.
 *
 * Set ORION_AUDIT_HMAC_KEY to a base64-encoded 32-byte secret for SOC2-grade
 * tamper-evidence. Without it, an attacker with UPDATE on AuditLog can modify
 * rows and recompute the chain. Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

import { prisma } from './db'
import type { NextRequest } from 'next/server'
import { createHash, createHmac } from 'crypto'

// Module-level cache for the HMAC key (null = no key / fallback to SHA-256)
let _auditHmacKeyCache: Buffer | null | undefined = undefined
let _auditHmacWarnedOnce = false
// Tracks whether we have already recorded the audit.hmac_chain_start SystemSetting
let _chainStartRecorded = false

/**
 * Return the 32-byte HMAC key from ORION_AUDIT_HMAC_KEY, or null if absent/invalid.
 * Result is cached for the lifetime of the process.
 * Soft-fail: logs a one-time warning and falls back to unkeyed SHA-256 rather than
 * throwing, so audit logging is never blocked by a missing env var.
 */
function getAuditHmacKey(): Buffer | null {
  if (_auditHmacKeyCache !== undefined) return _auditHmacKeyCache
  const raw = process.env.ORION_AUDIT_HMAC_KEY
  if (!raw) {
    if (!_auditHmacWarnedOnce) {
      console.warn(
        '[audit] ORION_AUDIT_HMAC_KEY not set — using unkeyed SHA-256. ' +
        'Tamper-evidence is degraded. Set the env var for SOC2 compliance.',
      )
      _auditHmacWarnedOnce = true
    }
    _auditHmacKeyCache = null
    return null
  }
  const key = Buffer.from(raw, 'base64')
  if (key.byteLength !== 32) {
    console.error('[audit] ORION_AUDIT_HMAC_KEY must be 32 bytes base64 — falling back to unkeyed SHA-256')
    _auditHmacKeyCache = null
    return null
  }
  _auditHmacKeyCache = key
  return key
}

export type AuditAction =
  | 'user_login'
  | 'user_login_failure'
  | 'user_logout'
  | 'user_create'
  | 'mfa_enable'
  | 'mfa_disable'
  | 'mfa_verify_success'
  | 'mfa_verify_failure'
  | 'user_update'
  | 'user_delete'
  | 'user_role_change'
  | 'api_key_create'
  | 'api_key_revoke'
  | 'environment_create'
  | 'environment_update'
  | 'environment_delete'
  | 'task_create'
  | 'task_update'
  | 'task_assign'
  | 'task_complete'
  | 'task_fail'
  | 'note_create'
  | 'note_update'
  | 'note_delete'
  | 'agent_create'
  | 'agent_update'
  | 'agent_delete'
  | 'model_create'
  | 'model_update'
  | 'model_delete'
  | 'tool_execute'
  | 'tool_approve'
  | 'tool_revoke'
  | 'sso_config_update'
  | 'admin_action'
  | 'settings_update'
  | 'vault_unseal'
  | 'vault_reseal'
  | 'password_reset'
  | 'ssrf_blocked'
  | 'encryption_key_rotation'
  | 'webhook_trigger_create'
  | 'webhook_trigger_delete'
  | 'logs_deleted'
  | 'cleanup_requested'
  | 'cleanup_requested_with_export'
  | 'cleanup_failed'
  | 'AUDIT_LOG_CLEANUP'
  | 'vulnerability_scan_trigger'
  | 'cve_finding_accept_risk'
  | 'containment_approve'
  | 'containment_reject'
  | 'github_connect'
  | 'github_disconnect'
  | 'github_allowlist_update'
  | 'mcp_token_rotate'

/**
 * Compute a hash of an audit entry's content for the hash chain.
 * Uses HMAC-SHA-256 when ORION_AUDIT_HMAC_KEY is set; falls back to unkeyed SHA-256.
 * The algorithm used matches what getPreviousHash and any verifier must use —
 * both are keyed or both are unkeyed for the same environment.
 */
function hashAuditEntry(entry: {
  id: string
  userId: string
  action: string
  target: string
  detail: unknown
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  previousHash: string | null
}): string {
  const data = JSON.stringify({
    id: entry.id,
    userId: entry.userId,
    action: entry.action,
    target: entry.target,
    detail: entry.detail,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt.toISOString(),
    previousHash: entry.previousHash,
  })
  const key = getAuditHmacKey()
  if (key) {
    return createHmac('sha256', key).update(data).digest('hex')
  }
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Compute the hash of the previous audit log entry for the hash chain.
 * Returns null if this is the first entry.
 */
async function getPreviousHash(): Promise<string | null> {
  try {
    const prev = await prisma.auditLog.findFirst({
      orderBy: { createdAt: 'desc' },
    })
    if (!prev) return null
    // Compute the hash of the previous entry's full content
    return hashAuditEntry(prev)
  } catch {
    return null
  }
}

/**
 * Log an audit event. Non-blocking — never throws.
 */
export async function logAudit(params: {
  userId: string
  action: AuditAction
  target: string
  detail?: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
}): Promise<void> {
  try {
    const prevHash = await getPreviousHash()
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        target: params.target,
        detail: (params.detail ?? {}) as any,
        ipAddress: params.ipAddress ?? undefined,
        userAgent: params.userAgent ?? undefined,
        previousHash: prevHash ?? undefined,
      },
    })
  } catch (e) {
    // Non-blocking — audit logging failures must not impact normal operations
    console.error('[audit] logAudit failed:', e)
  }
}

/**
 * Extract IP address from a Next.js request (respects X-Forwarded-For).
 * Works with NextRequest and other request objects.
 */
export function getClientIp(req: NextRequest | { headers: Headers; ip?: string }): string | undefined {
  // Prefer x-real-ip — set by the reverse proxy (Traefik/nginx) and not forwarded
  // from the client, making it harder to forge than X-Forwarded-For.
  const realIp = req.headers.get('x-real-ip')
  if (realIp) return realIp.trim()

  // Fall back to x-forwarded-for. Take the LAST token — the one appended by the
  // closest (most trusted) proxy — rather than the first, which is attacker-controlled.
  // The first XFF token is whatever the client sends; the last is what our proxy adds.
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const tokens = forwarded.split(',')
    return tokens[tokens.length - 1].trim()
  }

  // Fallback: NextRequest.ip (available in some deployments)
  if ('ip' in req && req.ip) return req.ip
  return undefined
}

/**
 * Extract user-agent from request headers.
 */
export function getUserAgent(headers: Headers | Record<string, string | null | string[]>): string | undefined {
  const val = typeof headers.get === 'function'
    ? headers.get('user-agent')
    : typeof headers === 'object' && 'user-agent' in headers
    ? headers['user-agent']
    : null
  return val ? (typeof val === 'string' ? val : val.join(', ')) : undefined
}
