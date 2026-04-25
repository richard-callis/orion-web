export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET() {
  await requireAdmin()
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(users)
}
