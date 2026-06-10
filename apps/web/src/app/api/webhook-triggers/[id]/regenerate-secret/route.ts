import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { randomBytes } from 'crypto'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const existing = await prisma.webhookTrigger.findUnique({ where: { id } })
  if (!existing) return new NextResponse(null, { status: 404 })

  const secret = randomBytes(32).toString('hex')
  await prisma.webhookTrigger.update({ where: { id }, data: { secret } })

  // Return the new secret — this is the only time it is shown in full
  return NextResponse.json({ secret })
}
