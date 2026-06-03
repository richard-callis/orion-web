import crypto from 'crypto'

const EXECUTOR_TOKEN = process.env.ORION_EXECUTOR_TOKEN || ''

export function validateExecutorToken(token: string): boolean {
  if (!token || !EXECUTOR_TOKEN) {
    return false
  }
  // Hash both sides before comparing so timingSafeEqual always receives
  // equal-length buffers. The raw form throws RangeError on length mismatch,
  // which (a) leaks token length as a timing oracle and (b) surfaces as 500
  // instead of 401. SHA-256 digests are always 32 bytes.
  const a = crypto.createHash('sha256').update(token).digest()
  const b = crypto.createHash('sha256').update(EXECUTOR_TOKEN).digest()
  return crypto.timingSafeEqual(a, b)
}
