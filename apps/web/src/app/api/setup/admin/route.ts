import { NextRequest, NextResponse } from 'next/server'
import { hash } from 'bcryptjs'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { username, password } = await req.json()

  if (!username?.trim()) {
    return NextResponse.json({ error: 'Username is required' }, { status: 400 })
  }
  if (!password || password.length < 10) {
    return NextResponse.json({ error: 'Password must be at least 10 characters' }, { status: 400 })
  }

  const existing = await prisma.user.findUnique({ where: { username: username.trim() } })
  if (existing) {
    return NextResponse.json({ error: 'Username already taken' }, { status: 409 })
  }

  const passwordHash = await hash(password, 12)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passwordChangedAt added in schema, awaiting migration
  await prisma.user.create({
    data: {
      username: username.trim(),
      email: `${username.trim()}@local`,
      passwordHash,
      passwordChangedAt: new Date(),
      role: 'admin',
      provider: 'local',
      active: true,
    },
  } as any)

  return NextResponse.json({ ok: true })
}
