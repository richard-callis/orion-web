import crypto from 'crypto'

const EXECUTOR_TOKEN = process.env.ORION_EXECUTOR_TOKEN || ''

export function validateExecutorToken(token: string): boolean {
  if (!token || !EXECUTOR_TOKEN) {
    return false
  }
  // Constant-time compare to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(EXECUTOR_TOKEN)
  )
}
