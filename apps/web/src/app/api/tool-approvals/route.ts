export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET() {
  await requireAdmin()
  const requests = await prisma.toolApprovalRequest.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return NextResponse.json(requests)
}
