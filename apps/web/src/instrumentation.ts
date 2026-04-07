export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureSetupToken } = await import('./lib/setup-token')
    await ensureSetupToken()
  }
}
