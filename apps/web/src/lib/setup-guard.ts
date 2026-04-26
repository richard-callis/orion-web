import { type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

export async function requireWizardSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get('__orion_wizard')?.value
  if (!token) return false
  // SOC2: NEXTAUTH_SECRET must be configured — no fallback.
  // Without it, wizard tokens cannot be verified and setup must be blocked.
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) return false
  try {
    const secretBytes = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, secretBytes)
    return payload.wizard === true
  } catch {
    return false
  }
}
