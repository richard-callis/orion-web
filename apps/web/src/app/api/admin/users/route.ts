export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError, CreateUserSchema } from '@/lib/validate'

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

  const user = await prisma.user.create({
    data: {
      username: data.username,
      email: data.email,
      password: data.password,
      name: data.name,
      role: data.role,
    },
  })

  return NextResponse.json(user, { status: 201 })
}
