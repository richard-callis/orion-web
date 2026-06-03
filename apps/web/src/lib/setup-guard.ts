import { type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { prisma } from './db'

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
    if (payload.wizard !== true) return false

    // B2 fix: wizard JWT carries no completion binding and lives for 1 hour.
    // Without this check, a token obtained during install remains valid post-setup
    // and can re-run any wizard route (re-init Vault, mint admins, repoint git).
    const completed = await prisma.systemSetting.findUnique({ where: { key: 'setup.completed' } })
    if (completed?.value) return false

    return true
  } catch {
    return false
  }
}
