export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureSetupToken, ensureLocalhostGateway } = await import('./lib/setup-token')
    await ensureSetupToken()
    await ensureLocalhostGateway()

    const { recoverStalledJobs } = await import('./lib/job-runner')
    await recoverStalledJobs()

    const { ensureSystemAgents } = await import('./lib/seed-system-agents')
    await ensureSystemAgents()

    const { ensureSystemEpic } = await import('./lib/seed-system-epic')
    await ensureSystemEpic()

    const { ensureActionPolicies } = await import('./lib/seed-action-policies')
    await ensureActionPolicies()

    const { ensureCorrelationRules } = await import('./lib/seed-correlation-rules')
    await ensureCorrelationRules()

    const { ensureSecurityRetentionJobScheduled } = await import('./jobs/security-retention-daily')
    await ensureSecurityRetentionJobScheduled()

    const { ensureSecurityStaleCheckJobScheduled } = await import('./jobs/security-stale-check')
    await ensureSecurityStaleCheckJobScheduled()

    // Wire the daily SOC2 audit export (was dead code — never scheduled).
    const { ensureAuditExportJobScheduled } = await import('./jobs/audit-export-daily')
    await ensureAuditExportJobScheduled()

    const { ensureSocConfig } = await import('./lib/seed-soc-config')
    await ensureSocConfig()

    // SOC2 [M-002]: Backfill encrypted TOTP columns for any users with plaintext values.
    const { migrateTotpToEncrypted } = await import('./lib/totp-migration')
    const totpResult = await migrateTotpToEncrypted()
    if (totpResult.migrated > 0) {
      console.log(`[totp-migration] Encrypted TOTP secrets for ${totpResult.migrated} users`)
    }

    // SOC2 [SSO-001]: Warn at startup if unsigned SSO headers are permitted.
    // SSO_ALLOW_UNSIGNED_SSO=true is only for rollout — must not persist in production.
    if (process.env.SSO_ALLOW_UNSIGNED_SSO === 'true') {
      console.warn(
        '[SOC2][SSO-001] SECURITY WARNING: SSO_ALLOW_UNSIGNED_SSO=true — ' +
        'SSO header authentication is running WITHOUT HMAC signature verification. ' +
        'Any request can forge identity headers. Set SSO_HMAC_SECRET and remove ' +
        'SSO_ALLOW_UNSIGNED_SSO before going to production.'
      )
    }

    // SOC2 CC5: validate critical security environment variables at startup
    const REQUIRED_SECURITY_VARS = ['NEXTAUTH_SECRET', 'ORION_ENCRYPTION_KEY']
    const WARN_IF_DEFAULT: Array<[string, string]> = [
      ['MINIO_ROOT_PASSWORD', 'change-me'],
      ['REDIS_PASSWORD', 'change-me'],
      ['POSTGRES_PASSWORD', 'change-me'],
    ]
    // SOC2 CC5: fail startup if critical secrets are set to known placeholder values
    const FAIL_IF_PLACEHOLDER: Array<[string, string[]]> = [
      ['NEXTAUTH_SECRET', ['change-me']],
      ['ORION_GATEWAY_TOKEN', ['change-me']],
    ]
    for (const v of REQUIRED_SECURITY_VARS) {
      if (!process.env[v]) {
        console.error(`[SOC2][startup] MISSING REQUIRED ENV VAR: ${v} — server security may be compromised`)
      }
    }
    for (const [v, def] of WARN_IF_DEFAULT) {
      if (!process.env[v] || process.env[v] === def) {
        console.warn(`[SOC2][startup] SECURITY WARNING: ${v} is unset or using placeholder value`)
      }
    }
    for (const [v, placeholders] of FAIL_IF_PLACEHOLDER) {
      const val = process.env[v]
      if (val && (placeholders.some(p => val.startsWith(p)) || placeholders.includes(val))) {
        throw new Error(
          `[SOC2][startup] FATAL: ${v} is set to a placeholder value ("${val}"). ` +
          `Generate a real secret with: openssl rand -base64 32`
        )
      }
    }
  }
}
