import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const tiers = await prisma.environmentUserTier.findMany({
    where: { environmentId: params.id },
    include: { user: { select: { id: true, username: true, email: true, name: true, role: true } } },
  })
  return NextResponse.json(tiers)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const { userId, tier } = await req.json()
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })
  const valid = ['viewer', 'operator', 'admin']
  if (!valid.includes(tier)) return NextResponse.json({ error: `tier must be one of: ${valid.join(', ')}` }, { status: 400 })

  const result = await prisma.environmentUserTier.upsert({
    where: { userId_environmentId: { userId, environmentId: params.id } },
    create: { userId, environmentId: params.id, tier },
    update: { tier },
    include: { user: { select: { id: true, username: true, email: true, name: true, role: true } } },
  })
  return NextResponse.json(result)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })
  await prisma.environmentUserTier.deleteMany({ where: { userId, environmentId: params.id } })
  return new NextResponse(null, { status: 204 })
}
