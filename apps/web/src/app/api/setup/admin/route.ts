import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'
import { parseBodyOrError, SetupAdminSchema } from '@/lib/validate'
import { logAudit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await parseBodyOrError(req, SetupAdminSchema)
  if ('error' in result) return result.error
  const { data } = result
  const username = data.username.trim()
  const password = data.password

  // B1 fix: prevent creating additional admins after setup completes.
  // No first-admin-only guard existed — any valid wizard cookie could mint
  // unlimited admin accounts post-setup.
  const setupCompleted = await prisma.systemSetting.findUnique({ where: { key: 'setup.completed' } })
  if (setupCompleted?.value) {
    return NextResponse.json({ error: 'Setup already complete — cannot create additional admins via wizard' }, { status: 403 })
  }

  const existing = await prisma.user.findUnique({ where: { username } })
  if (existing) {
    return NextResponse.json({ error: 'Username already taken' }, { status: 409 })
  }

  const passwordHash = await hash(password, 14)

  const createdUser = await prisma.user.create({
    data: {
      username,
      email: `${username}@local`,
      passwordHash,
      role: 'admin',
      provider: 'local',
      active: true,
    },
  })

  void logAudit({
    userId: createdUser.id,
    action: 'user_create',
    target: createdUser.id,
    detail: { source: 'setup_wizard', role: 'admin' },
  })

  return NextResponse.json({ ok: true })
}
