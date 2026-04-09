export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const requests = await prisma.toolApprovalRequest.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(requests)
}
