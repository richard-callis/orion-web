import { randomBytes } from 'crypto'
import { hash } from 'bcryptjs'
import { prisma } from './db'

export async function ensureSetupToken(): Promise<void> {
  // No-op if setup is already complete
  const completed = await prisma.systemSetting.findUnique({
    where: { key: 'setup.completed' },
  })
  if (completed?.value === true) return

  // Idempotent — don't regenerate if token already exists (handles restarts during setup)
  const existing = await prisma.systemSetting.findUnique({
    where: { key: 'setup.token' },
  })
  if (existing) {
    console.log('[orion] First-run setup pending. Check Docker logs for SETUP_TOKEN.')
    return
  }

  const token = randomBytes(32).toString('hex')
  const tokenHash = await hash(token, 12)

  await prisma.systemSetting.create({
    data: { key: 'setup.token', value: tokenHash },
  })

  // bootstrap.sh greps for this exact line
  console.log(`SETUP_TOKEN: ${token}`)
  console.log('[orion] Visit http://<management-ip>:3000/setup to complete first-run setup.')
}
