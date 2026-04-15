import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)

  const current = await prisma.ingressRoute.findUniqueOrThrow({ where: { id: params.id } })
  const nowEnabled = !current.enabled

  const route = await prisma.ingressRoute.update({
    where: { id: params.id },
    data: {
      enabled:    nowEnabled,
      disabledAt: nowEnabled ? null : new Date(),
      disabledBy: nowEnabled ? null : (session?.user?.name ?? 'unknown'),
    },
  })

  return NextResponse.json(route)
}
