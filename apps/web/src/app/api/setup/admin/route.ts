import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'
import { parseBodyOrError, SetupAdminSchema } from '@/lib/validate'

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await parseBodyOrError(req, SetupAdminSchema)
  if ('error' in result) return result.error
  const { data } = result
  const username = data.username.trim()
  const password = data.password

  const existing = await prisma.user.findUnique({ where: { username } })
  if (existing) {
    return NextResponse.json({ error: 'Username already taken' }, { status: 409 })
  }

  const passwordHash = await hash(password, 14)

  await prisma.user.create({
    data: {
      username,
      email: `${username}@local`,
      passwordHash,
      role: 'admin',
      provider: 'local',
      active: true,
    },
  })

  return NextResponse.json({ ok: true })
}
