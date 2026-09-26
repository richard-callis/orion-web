/**
 * Validate critical security configuration before anything else runs.
 * Throws (aborting startup) on a missing required secret in production or a
 * known placeholder value anywhere; only warns for non-critical defaults.
 */
export function validateSecurityEnv(env: NodeJS.ProcessEnv = process.env): void {
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

  const missing = REQUIRED_SECURITY_VARS.filter(v => !env[v])
  if (missing.length > 0) {
    const msg = `[SOC2][startup] MISSING REQUIRED ENV VAR(S): ${missing.join(', ')}`
    // Sessions can't be signed and encrypted secrets can't be read without
    // these — refuse to serve in production rather than run insecurely.
    if (env.NODE_ENV === 'production') throw new Error(`${msg} — refusing to start`)
    console.error(`${msg} — server security may be compromised`)
  }
  for (const [v, def] of WARN_IF_DEFAULT) {
    if (!env[v] || env[v] === def) {
      console.warn(`[SOC2][startup] SECURITY WARNING: ${v} is unset or using placeholder value`)
    }
  }
  for (const [v, placeholders] of FAIL_IF_PLACEHOLDER) {
    const val = env[v]
    if (val && (placeholders.some(p => val.startsWith(p)) || placeholders.includes(val))) {
      throw new Error(
        `[SOC2][startup] FATAL: ${v} is set to a placeholder value. ` +
        `Generate a real secret with: openssl rand -base64 32`
      )
    }
  }

  // SOC2 [SSO-001]: Warn at startup if unsigned SSO headers are permitted.
  // SSO_ALLOW_UNSIGNED_SSO=true is only for rollout — must not persist in production.
  if (env.SSO_ALLOW_UNSIGNED_SSO === 'true') {
    console.warn(
      '[SOC2][SSO-001] SECURITY WARNING: SSO_ALLOW_UNSIGNED_SSO=true — ' +
      'SSO header authentication is running WITHOUT HMAC signature verification. ' +
      'Any request can forge identity headers. Set SSO_HMAC_SECRET and remove ' +
      'SSO_ALLOW_UNSIGNED_SSO before going to production.'
    )
  }
}

/**
 * Run one startup step, logging (not propagating) its failure so a single
 * broken seed doesn't prevent every later step from running.
 */
async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    console.error(`[startup] ${name} failed:`, e)
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Security configuration first, and fatal — before any seeding touches the DB.
    validateSecurityEnv()

    await step('ensureSetupToken', async () => {
      const { ensureSetupToken } = await import('./lib/setup-token')
      await ensureSetupToken()
    })
    await step('ensureLocalhostGateway', async () => {
      const { ensureLocalhostGateway } = await import('./lib/setup-token')
      await ensureLocalhostGateway()
    })
    await step('recoverStalledJobs', async () => {
      // Heartbeat-based: only fails jobs whose owner has stopped responding.
      const { recoverStalledJobs } = await import('./lib/job-runner')
      await recoverStalledJobs()
    })
    await step('ensureSystemAgents', async () => {
      const { ensureSystemAgents } = await import('./lib/seed-system-agents')
      await ensureSystemAgents()
    })
    await step('ensureSystemEpic', async () => {
      const { ensureSystemEpic } = await import('./lib/seed-system-epic')
      await ensureSystemEpic()
    })
    await step('ensureActionPolicies', async () => {
      const { ensureActionPolicies } = await import('./lib/seed-action-policies')
      await ensureActionPolicies()
    })
    await step('ensureCorrelationRules', async () => {
      const { ensureCorrelationRules } = await import('./lib/seed-correlation-rules')
      await ensureCorrelationRules()
    })
    await step('ensureSocConfig', async () => {
      const { ensureSocConfig } = await import('./lib/seed-soc-config')
      await ensureSocConfig()
    })
    await step('migrateTotpToEncrypted', async () => {
      // SOC2 [M-002]: Backfill encrypted TOTP columns for any users with plaintext values.
      const { migrateTotpToEncrypted } = await import('./lib/totp-migration')
      const totpResult = await migrateTotpToEncrypted()
      if (totpResult.migrated > 0) {
        console.log(`[totp-migration] Encrypted TOTP secrets for ${totpResult.migrated} users`)
      }
    })

    // Scheduled jobs (security retention, stale-check, audit export, AUDIT-001
    // retention) are registered by the worker process — see jobs/scheduled-jobs.ts.
  }
}
