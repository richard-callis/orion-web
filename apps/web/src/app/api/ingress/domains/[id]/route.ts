import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }
  const body = await req.json()
  const domain = await prisma.domain.update({
    where: { id: params.id },
    data: {
      ...(body.name                 !== undefined && { name:                 body.name.trim().toLowerCase() }),
      ...(body.type                 !== undefined && { type:                 body.type }),
      ...(body.notes                !== undefined && { notes:                body.notes }),
      ...(body.coreDnsEnvironmentId !== undefined && { coreDnsEnvironmentId: body.coreDnsEnvironmentId || null }),
      ...(body.coreDnsIp            !== undefined && { coreDnsIp:            body.coreDnsIp || null }),
      ...(body.coreDnsStatus        !== undefined && { coreDnsStatus:        body.coreDnsStatus }),
    },
    include: {
      ingressPoints: {
        include: {
          environment: { select: { id: true, name: true } },
          routes: { orderBy: { host: 'asc' } },
        },
      },
    },
  })
  return NextResponse.json(domain)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }
  await prisma.domain.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
