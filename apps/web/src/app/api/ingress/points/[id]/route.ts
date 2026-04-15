import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const point = await prisma.ingressPoint.update({
    where: { id: params.id },
    data: {
      ...(body.name          !== undefined && { name:          body.name.trim() }),
      ...(body.type          !== undefined && { type:          body.type }),
      ...(body.ip            !== undefined && { ip:            body.ip || null }),
      ...(body.port          !== undefined && { port:          Number(body.port) }),
      ...(body.certManager   !== undefined && { certManager:   body.certManager }),
      ...(body.clusterIssuer !== undefined && { clusterIssuer: body.clusterIssuer || null }),
      ...(body.status        !== undefined && { status:        body.status }),
      ...(body.comment       !== undefined && { comment:       body.comment || null }),
      ...(body.environmentId !== undefined && { environmentId: body.environmentId || null }),
    },
    include: {
      environment: { select: { id: true, name: true } },
      routes: { orderBy: { host: 'asc' } },
    },
  })
  return NextResponse.json(point)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.ingressPoint.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
