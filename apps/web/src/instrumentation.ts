export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureSetupToken, ensureLocalhostGateway } = await import('./lib/setup-token')
    await ensureSetupToken()
    await ensureLocalhostGateway()

    const { recoverStalledJobs } = await import('./lib/job-runner')
    await recoverStalledJobs()
  }
}
