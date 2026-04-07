import { type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

export async function requireWizardSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get('__orion_wizard')?.value
  if (!token) return false
  try {
    const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET ?? 'fallback-secret')
    const { payload } = await jwtVerify(token, secret)
    return payload.wizard === true
  } catch {
    return false
  }
}
