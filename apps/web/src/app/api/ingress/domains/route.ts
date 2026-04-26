import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  // Auto-seed domains from system settings if the table is empty
  const count = await prisma.domain.count()
  if (count === 0) {
    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: ['domain.internal', 'domain.public'] } },
    })
    const byKey = Object.fromEntries(settings.map((s: any) => [s.key, s.value as string]))
    const seeds = []
    if (byKey['domain.public'])   seeds.push({ name: byKey['domain.public'],   type: 'public' })
    if (byKey['domain.internal']) seeds.push({ name: byKey['domain.internal'], type: 'internal' })
    if (seeds.length > 0) {
      await prisma.domain.createMany({ data: seeds, skipDuplicates: true })
    }
  }

  const domains = await prisma.domain.findMany({
    orderBy: { name: 'asc' },
    include: {
      ingressPoints: {
        include: {
          environment: { select: { id: true, name: true } },
          routes:      { orderBy: { host: 'asc' } },
          middlewares: { orderBy: { name: 'asc' } },
        },
        orderBy: { name: 'asc' },
      },
    },
  })
  return NextResponse.json(domains)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const domain = await prisma.domain.create({
    data: {
      name:  body.name.trim().toLowerCase(),
      type:  body.type  ?? 'public',
      notes: body.notes ?? null,
    },
    include: { ingressPoints: true },
  })
  return NextResponse.json(domain, { status: 201 })
}
