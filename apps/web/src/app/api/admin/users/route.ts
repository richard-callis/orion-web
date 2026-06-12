export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError, CreateUserSchema } from '@/lib/validate'
import { hash } from 'bcryptjs'
import { logAudit } from '@/lib/audit'

// Fields safe to return — never include passwordHash, totpSecret, totpRecoveryCodes
const SAFE_USER_SELECT = {
  id: true, username: true, email: true, name: true, role: true,
  active: true, provider: true, totpEnabled: true,
  createdAt: true, updatedAt: true, lastSeen: true,
} as const

export async function GET() {
  await requireAdmin()
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: SAFE_USER_SELECT,
    take: 500,
  })
  return NextResponse.json(users)
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin()
  const result = await parseBodyOrError(req, CreateUserSchema)
  if ('error' in result) return result.error
  const { data } = result

  const passwordHash = await hash(data.password, 14)

  const user = await prisma.user.create({
    data: { username: data.username, email: data.email, passwordHash, name: data.name, role: data.role },
    select: SAFE_USER_SELECT,
  })

  await logAudit({
    userId: admin.id,
    action: 'user_create',
    target: user.id,
    detail: { username: user.username, role: user.role },
  })

  return NextResponse.json(user, { status: 201 })
}
