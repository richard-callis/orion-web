import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET() {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }

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
    take: 200,
  })
  return NextResponse.json(domains)
}

export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }

  // SOC2 [LOW-3]: domain seeding moved from GET to POST to keep GET read-only (CSRF safety)
  // Auto-seed domains from system settings if the table is empty
  const count = await prisma.domain.count()
  if (count === 0) {
    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: ['domain.internal', 'domain.public'] } },
    })
    const byKey = Object.fromEntries(settings.map((s: any) => [s.key, s.value as string]))
    const seeds: Array<{ name: string; type: string }> = []
    if (byKey['domain.public'])   seeds.push({ name: byKey['domain.public'],   type: 'public' })
    if (byKey['domain.internal']) seeds.push({ name: byKey['domain.internal'], type: 'internal' })
    if (seeds.length > 0) {
      await prisma.domain.createMany({ data: seeds, skipDuplicates: true })
    }
  }

  const body = await req.json()
  const DOMAIN_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
  const name = (body.name ?? '').trim().toLowerCase()
  if (!name || !DOMAIN_NAME_RE.test(name)) {
    return NextResponse.json({ error: 'Invalid domain name' }, { status: 400 })
  }
  const domain = await prisma.domain.create({
    data: {
      name,
      type:  body.type  ?? 'public',
      notes: body.notes ?? null,
    },
    include: { ingressPoints: true },
  })
  return NextResponse.json(domain, { status: 201 })
}
