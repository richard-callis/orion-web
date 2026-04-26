export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError, CreateUserSchema } from '@/lib/validate'
import { hash } from 'bcryptjs'

export async function GET() {
  await requireAdmin()
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(users)
}

export async function POST(req: NextRequest) {
  await requireAdmin()
  const result = await parseBodyOrError(req, CreateUserSchema)
  if ('error' in result) return result.error
  const { data } = result

  // Hash password before storing (cost 14 to match password validation)
  const passwordHash = await hash(data.password, 14)

  const user = await prisma.user.create({
    data: {
      username: data.username,
      email: data.email,
      passwordHash,
      name: data.name,
      role: data.role,
    },
  })

  return NextResponse.json(user, { status: 201 })
}
