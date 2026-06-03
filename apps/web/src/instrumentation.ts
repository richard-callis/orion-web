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

    // Wire the daily SOC2 audit export (was dead code — never scheduled).
    const { ensureAuditExportJobScheduled } = await import('./jobs/audit-export-daily')
    await ensureAuditExportJobScheduled()

    const { ensureSocConfig } = await import('./lib/seed-soc-config')
    await ensureSocConfig()
  }
}
